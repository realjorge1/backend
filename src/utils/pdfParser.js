/**
 * PDF text parsing utility.
 *
 * Extracts text + page count from a PDF buffer.
 * Primary:  pdfjs-dist (handles all PDF types including scanned-ish ones)
 * Fallback: pdf-parse v1 legacy callable (if somehow available)
 *
 * NOTE: pdf-parse v2 (installed in this project) uses a completely different
 * API that requires file paths, not buffers — it is NOT used here directly.
 */

const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const crypto = require("crypto");

// ── pdfjs-dist worker URL (resolved once at startup) ─────────────────────────
let _workerSrc = null;

function _getWorkerSrc() {
  if (_workerSrc !== null) return _workerSrc;
  try {
    // Locate the worker via the main legacy build (always resolvable)
    const legacyMjs = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const pkgRoot = path.dirname(path.dirname(path.dirname(legacyMjs)));
    const workerFile = path.join(
      pkgRoot,
      "legacy",
      "build",
      "pdf.worker.mjs",
    );
    // Node.js Worker requires a file:// URL
    _workerSrc = "file:///" + workerFile.split(path.sep).join("/");
  } catch {
    _workerSrc = "";
  }
  return _workerSrc;
}

// ── pdf-parse v2 wrapper (uses temp-file + PDFParse class) ───────────────────
async function _parsePdfV2(dataBuffer) {
  const { PDFParse } = require("pdf-parse");
  const tmpPath = path.join(
    os.tmpdir(),
    `pdfparser_${crypto.randomUUID()}.pdf`,
  );
  try {
    await fs.writeFile(tmpPath, dataBuffer);
    const fileUrl = "file:///" + tmpPath.split(path.sep).join("/");
    const parser = new PDFParse({ verbosity: 0 });
    await parser.load(fileUrl);
    const raw = await parser.getText();
    // getText() may return an array of objects or a string
    let text = "";
    if (typeof raw === "string") {
      text = raw;
    } else if (Array.isArray(raw)) {
      text = raw.map((r) => r?.str || r?.text || String(r || "")).join(" ");
    } else if (raw && typeof raw === "object") {
      text = JSON.stringify(raw);
    }
    return { text, numpages: 0 };
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

// ── pdfjs-dist fallback ──────────────────────────────────────────────────────
async function _parsePdfWithPdfjs(dataBuffer) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Configure worker (required in pdfjs-dist v4)
  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = _getWorkerSrc();
  }

  const doc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(dataBuffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
    })
    .promise;

  const textParts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str || "").join(" ");
    textParts.push(pageText);
  }

  const numpages = doc.numPages;
  await doc.destroy();
  return { text: textParts.join("\n"), numpages };
}

/**
 * Parse a PDF buffer and return { text, numpages }.
 *
 * Tries in order:
 *   1. pdfjs-dist (most reliable for Node.js)
 *   2. pdf-parse v2 wrapper (temp-file based)
 */
async function parsePDF(dataBuffer) {
  // Primary: pdfjs-dist
  try {
    const result = await _parsePdfWithPdfjs(dataBuffer);
    return result;
  } catch (pdfjsErr) {
    console.warn(
      "[pdfParser] pdfjs-dist failed, trying pdf-parse:",
      pdfjsErr.message,
    );
  }

  // Fallback: pdf-parse v2
  try {
    return await _parsePdfV2(dataBuffer);
  } catch (v2Err) {
    console.warn("[pdfParser] pdf-parse v2 also failed:", v2Err.message);
  }

  // Last resort: return empty result rather than crashing
  return { text: "", numpages: 0 };
}

module.exports = { parsePDF };
