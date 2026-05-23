/**
 * PDF Extractor Service
 * Handles both text-based and scanned PDFs.
 * Strategy: PDF.js for text PDFs → Tesseract OCR fallback for scanned pages.
 *
 * Dependencies: pdfjs-dist, tesseract.js, canvas
 */

const Tesseract = require("tesseract.js");

// Threshold: pages with fewer non-whitespace chars than this are treated as scanned
const SCANNED_CHAR_THRESHOLD = 30;

// Lazy-loaded pdfjs reference — pdfjs-dist v4 is ESM-only, so we use dynamic import()
let _pdfjsLib = null;

async function getPdfjs() {
  if (!_pdfjsLib) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // On Windows, absolute paths must be file:// URLs for the ESM loader (c:\ is not a valid URL scheme)
    const { pathToFileURL } = require("url");
    const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    _pdfjsLib = pdfjs;
  }
  return _pdfjsLib;
}

/**
 * Main entry point: extract all pages from a PDF buffer.
 * @param {Buffer} pdfBuffer - Raw PDF file buffer
 * @returns {Promise<{ pages: Array, meta: Object }>}
 */
async function extractPdfText(pdfBuffer) {
  const pdfjsLib = await getPdfjs();
  const uint8Array = new Uint8Array(pdfBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data: uint8Array,
    useSystemFonts: true,
  });

  const pdfDoc = await loadingTask.promise;
  const totalPages = pdfDoc.numPages;

  const pages = [];
  let scannedPageCount = 0;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const result = await extractPageText(page, pageNum);

    if (result.wasOcr) scannedPageCount++;
    pages.push(result);
  }

  return {
    pages,
    meta: {
      totalPages,
      scannedPages: scannedPageCount,
      isFullyScanned: scannedPageCount === totalPages,
      hasScannedContent: scannedPageCount > 0,
    },
  };
}

/**
 * Extract text from a single PDF page.
 * Falls back to OCR if the page appears to be scanned (very little text).
 */
async function extractPageText(page, pageNum) {
  const textContent = await page.getTextContent();
  const rawText = buildTextFromItems(textContent.items);

  const isScanned = rawText.replace(/\s/g, "").length < SCANNED_CHAR_THRESHOLD;

  if (isScanned) {
    try {
      const ocrText = await ocrPage(page);
      return {
        page: pageNum,
        text: ocrText,
        wasOcr: true,
        charCount: ocrText.length,
      };
    } catch (ocrErr) {
      // OCR failed (canvas not installed, etc.).
      // Return only whatever text PDF.js found — do NOT add a placeholder string.
      // A placeholder fools downstream filters into thinking the page has content,
      // causing the quiz to attempt generation and then drop every question.
      // An empty/near-empty text correctly signals "no extractable content" and
      // produces an actionable "insufficient content" message for the user.
      console.warn(
        `[pdfExtractor] OCR unavailable for page ${pageNum} (install 'canvas' for scanned PDFs):`,
        ocrErr.message,
      );
      return {
        page: pageNum,
        text: rawText,
        wasOcr: false,
        charCount: rawText.length,
      };
    }
  }

  return {
    page: pageNum,
    text: rawText,
    wasOcr: false,
    charCount: rawText.length,
  };
}

/**
 * Reconstruct reading-order text from PDF.js text items.
 * Groups items by line (Y position), sorts lines top→bottom,
 * sorts words within a line left→right.
 */
function buildTextFromItems(items) {
  if (!items || items.length === 0) return "";

  const LINE_BAND = 5; // px tolerance to group items on same line

  const positioned = items
    .filter((item) => item.str && item.str.trim() !== "")
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      fontSize: Math.abs(item.transform[0]),
    }));

  if (positioned.length === 0) return "";

  // Group into lines by Y coordinate
  const lines = [];
  for (const item of positioned) {
    const existingLine = lines.find((l) => Math.abs(l.y - item.y) < LINE_BAND);
    if (existingLine) {
      existingLine.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  // Sort lines: PDF Y-axis is bottom-up, so higher Y = higher on page
  lines.sort((a, b) => b.y - a.y);

  // Sort items within each line left→right
  lines.forEach((line) => line.items.sort((a, b) => a.x - b.x));

  const lineStrings = lines.map((line) => {
    return line.items
      .map((item) => item.text)
      .join(" ")
      .trim();
  });

  return lineStrings
    .filter((l) => l.length > 0)
    .join("\n")
    .trim();
}

/**
 * Render a PDF page to an image and run Tesseract OCR on it.
 * Requires the `canvas` npm package.
 */
async function ocrPage(page) {
  const { createCanvas } = require("canvas");
  const SCALE = 2.0; // Higher = better OCR accuracy, more memory

  const viewport = page.getViewport({ scale: SCALE });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");

  // White background
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const imageBuffer = canvas.toBuffer("image/png");

  const { data } = await Tesseract.recognize(imageBuffer, "eng", {
    logger: () => {}, // suppress console spam
  });

  return data.text.trim();
}

module.exports = { extractPdfText };
