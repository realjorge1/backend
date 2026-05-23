/**
 * PDF text extraction using pdfjs-dist (Mozilla PDF.js).
 *
 * Replaces the unreliable pdf2json pipeline. pdfjs-dist returns coordinates
 * in native PDF points — the same coordinate system pdf-lib uses — so no
 * UNIT conversion is needed.
 */

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

let _pdfjsLib = null;

async function getPdfjsLib() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // pdfjs-dist 4.x on Windows requires a file:// URL, not a raw path.
    const workerPath = path.join(
      path.dirname(require.resolve("pdfjs-dist/package.json")),
      "legacy",
      "build",
      "pdf.worker.mjs",
    );
    _pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  }
  return _pdfjsLib;
}

/**
 * Extract every text item from a PDF with its position in PDF-point coordinates.
 *
 * IMPORTANT: Always reads file as Buffer to avoid Windows file path issues
 * with pdfjs-dist's URL-based loading.
 *
 * @param {string|Buffer} source  – file path or Buffer
 * @returns {Promise<{
 *   pages: Array<{
 *     pageNum: number,
 *     width: number,
 *     height: number,
 *     items: Array<{
 *       text: string,
 *       x: number,
 *       y: number,
 *       w: number,
 *       h: number,
 *       fontName: string
 *     }>
 *   }>
 * }>}
 */
async function extractTextWithPositions(source) {
  const pdfjsLib = await getPdfjsLib();

  // Always read as Buffer to avoid Windows path issues with pdfjs-dist URL loading
  let pdfData;
  if (Buffer.isBuffer(source)) {
    pdfData = new Uint8Array(source);
  } else {
    // source is a file path — read it into memory
    const fileBuffer = fs.readFileSync(source);
    pdfData = new Uint8Array(fileBuffer);
  }

  const loadOpts = {
    data: pdfData,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    // Increase verbosity in debug to catch silent errors
    verbosity: 0,
  };

  let doc;
  try {
    doc = await pdfjsLib.getDocument(loadOpts).promise;
  } catch (err) {
    throw new Error(`PDF text extraction failed: ${err.message}`);
  }

  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items = [];
    for (const item of content.items) {
      if (!item.str || item.str.trim() === "") continue;

      // transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const tx = item.transform;
      const x = tx[4];
      const y = tx[5];
      const w = item.width;
      // item.height is 0 for many PDFs in pdfjs-dist 4.x (font ascent not reported).
      // Fall back to the vertical scale from the text rendering matrix (= font size).
      const transformScale = Math.abs(tx[3]) || Math.abs(tx[0]);
      const h = item.height > 0 ? item.height : (transformScale || 12);

      items.push({
        text: item.str,
        x,
        y,
        w,
        h,
        fontName: item.fontName || "",
      });
    }

    pages.push({
      pageNum: i,
      width: viewport.width,
      height: viewport.height,
      items,
    });
  }

  await doc.destroy();
  return { pages };
}

/**
 * Build full lines of text from items on each page by grouping items that
 * share approximately the same y-coordinate.
 *
 * @param {Array} pages – output of extractTextWithPositions().pages
 * @returns {Array<{ pageNum: number, lines: Array<{ text: string, items: Array }> }>}
 */
function buildLines(pages) {
  return pages.map((page) => {
    if (page.items.length === 0) return { pageNum: page.pageNum, lines: [] };

    // Sort items top-to-bottom (higher y = higher on page), then left-to-right
    const sorted = [...page.items].sort((a, b) => {
      const dy = b.y - a.y; // descending y
      if (Math.abs(dy) > 2) return dy;
      return a.x - b.x; // ascending x
    });

    const lines = [];
    let currentLine = { items: [sorted[0]], y: sorted[0].y };

    for (let i = 1; i < sorted.length; i++) {
      const item = sorted[i];
      // Same line if y is within 3 points
      if (Math.abs(item.y - currentLine.y) <= 3) {
        currentLine.items.push(item);
      } else {
        lines.push(currentLine);
        currentLine = { items: [item], y: item.y };
      }
    }
    lines.push(currentLine);

    return {
      pageNum: page.pageNum,
      lines: lines.map((line) => {
        // Sort items within each line left-to-right
        line.items.sort((a, b) => a.x - b.x);
        return {
          text: line.items.map((it) => it.text).join(" "),
          items: line.items,
        };
      }),
    };
  });
}

/**
 * Find all occurrences of `searchText` across extracted pages.
 *
 * Strategy:
 * 1. Check each individual text item for matches.
 * 2. Check concatenated line text for cross-fragment matches.
 *
 * Returns regions in PDF-point coordinates suitable for pdf-lib drawing.
 *
 * @param {Array} pages – from extractTextWithPositions().pages
 * @param {string} searchText
 * @param {object} [opts]
 * @param {boolean} [opts.caseSensitive=false]
 * @returns {{ matches: Array<{ pageNum: number, pageIdx: number, regions: Array<{x,y,w,h}>, matchedText: string }>, total: number }}
 */
function findMatches(pages, searchText, opts = {}) {
  const caseSensitive = opts.caseSensitive ?? false;
  const needle = caseSensitive ? searchText : searchText.toLowerCase();
  const matches = [];

  const pagesWithLines = buildLines(pages);

  for (let pIdx = 0; pIdx < pagesWithLines.length; pIdx++) {
    const page = pagesWithLines[pIdx];

    for (const line of page.lines) {
      const lineText = caseSensitive ? line.text : line.text.toLowerCase();

      let searchFrom = 0;
      while (true) {
        const matchIdx = lineText.indexOf(needle, searchFrom);
        if (matchIdx === -1) break;

        // Map the character range [matchIdx, matchIdx+needle.length) back to items
        const regions = mapCharRangeToRegions(
          line.items,
          line.text,
          matchIdx,
          matchIdx + needle.length,
        );

        if (regions.length > 0) {
          matches.push({
            pageNum: page.pageNum,
            pageIdx: pIdx,
            regions,
            matchedText: line.text.substring(
              matchIdx,
              matchIdx + needle.length,
            ),
          });
        }

        searchFrom = matchIdx + 1;
      }
    }
  }

  return { matches, total: matches.length };
}

/**
 * Map a character range in the joined line text back to the source items'
 * bounding boxes.
 *
 * @param {Array} items – sorted items in the line
 * @param {string} lineText – items joined with " "
 * @param {number} start – char start index in lineText
 * @param {number} end – char end index in lineText
 * @returns {Array<{x: number, y: number, w: number, h: number}>}
 */
function mapCharRangeToRegions(items, lineText, start, end) {
  const regions = [];
  let charPos = 0;

  for (const item of items) {
    const itemStart = charPos;
    const itemEnd = charPos + item.text.length;

    // Check overlap
    if (itemEnd > start && itemStart < end) {
      // This item participates in the match
      const overlapStart = Math.max(start, itemStart) - itemStart;
      const overlapEnd = Math.min(end, itemEnd) - itemStart;

      // Estimate character-level positions within the item
      const charWidth =
        item.text.length > 0 ? item.w / item.text.length : item.w;
      const regionX = item.x + overlapStart * charWidth;
      const regionW = (overlapEnd - overlapStart) * charWidth;

      regions.push({
        x: regionX,
        y: item.y,
        w: regionW,
        h: item.h,
      });
    }

    charPos = itemEnd + 1; // +1 for the space separator
  }

  return regions;
}

module.exports = {
  extractTextWithPositions,
  buildLines,
  findMatches,
};
