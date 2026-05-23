/**
 * PDF Repair Service (Enhanced)
 * ─────────────────────────────────────────────────────────────────────
 * Multi-strategy PDF repair:
 *   1. qpdf  (preferred — fixes xref tables, linearises)
 *   2. Ghostscript (deep re-render)
 *   3. pdf-lib (structural rebuild, always available)
 *
 * Falls through strategies until one succeeds.
 * ─────────────────────────────────────────────────────────────────────
 */

const fs = require("fs").promises;
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const { PDFDocument } = require("pdf-lib");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tmpPath(ext = ".pdf") {
  return path.join(os.tmpdir(), `inscribed_repair_${uuidv4()}${ext}`);
}

function execAsync(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      cmd,
      args,
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      },
    );
  });
}

async function commandExists(cmd) {
  try {
    const which = os.platform() === "win32" ? "where" : "which";
    await execAsync(which, [cmd], 5000);
    return true;
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────
// Repair Strategies
// ────────────────────────────────────────────────────────────────────

/**
 * Strategy 1: qpdf — fast xref-table rebuild + linearisation.
 */
async function repairWithQpdf(inputPath) {
  if (!(await commandExists("qpdf"))) return null;

  const outputPath = tmpPath();
  try {
    await execAsync("qpdf", [
      "--replace-input",
      // Don't actually replace; write to output
      inputPath,
      "--linearize",
      "--object-streams=generate",
      outputPath,
    ]).catch(() => {
      // qpdf --replace-input doesn't work with an output arg.
      // Use the standard form instead.
    });

    // Standard invocation:
    const output2 = tmpPath();
    await execAsync("qpdf", [
      "--linearize",
      "--object-streams=generate",
      "--warning-exit-0",
      inputPath,
      output2,
    ]);

    const repaired = await fs.readFile(output2);
    await fs.unlink(output2).catch(() => {});
    return repaired;
  } catch (err) {
    console.warn("[PdfRepairService] qpdf failed:", err.message);
    // Clean up
    try {
      await fs.unlink(outputPath).catch(() => {});
    } catch {}
    return null;
  }
}

/**
 * Strategy 2: Ghostscript — full re-render.
 * Handles deeply corrupt PDFs that qpdf cannot.
 */
async function repairWithGhostscript(inputPath) {
  const gs = os.platform() === "win32" ? "gswin64c" : "gs";
  if (!(await commandExists(gs))) return null;

  const outputPath = tmpPath();
  try {
    await execAsync(
      gs,
      [
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dPDFSETTINGS=/default",
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      60_000,
    ); // Longer timeout for GS

    const repaired = await fs.readFile(outputPath);
    await fs.unlink(outputPath).catch(() => {});
    return repaired;
  } catch (err) {
    console.warn("[PdfRepairService] Ghostscript failed:", err.message);
    try {
      await fs.unlink(outputPath).catch(() => {});
    } catch {}
    return null;
  }
}

/**
 * Strategy 3: pdf-lib structural rebuild (always available).
 * Re-loads with lenient flags, re-serializes with object streams.
 * Falls back to copying individual pages into a fresh document if the
 * initial load/save fails.
 */
async function repairWithPdfLib(inputPath) {
  const pdfBytes = await fs.readFile(inputPath);

  // Attempt 1: lenient load + full re-save
  try {
    const pdf = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });

    const repairedBytes = await pdf.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    return Buffer.from(repairedBytes);
  } catch (err) {
    console.warn(
      "[PdfRepairService] pdf-lib full load failed:",
      err.message,
    );
  }

  // Attempt 2: try to copy recoverable pages into a fresh document
  try {
    const src = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
      capNumbers: true,
    });
    const dst = await PDFDocument.create();
    const pageCount = src.getPageCount();
    if (pageCount === 0) return null;

    for (let i = 0; i < pageCount; i++) {
      try {
        const [copied] = await dst.copyPages(src, [i]);
        dst.addPage(copied);
      } catch {
        // Skip unrecoverable pages
        console.warn(`[PdfRepairService] skipping unrecoverable page ${i + 1}`);
      }
    }

    if (dst.getPageCount() === 0) return null;
    return Buffer.from(await dst.save());
  } catch (err) {
    console.warn("[PdfRepairService] pdf-lib page-copy failed:", err.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Main Repair Function
// ────────────────────────────────────────────────────────────────────

/**
 * Attempt to repair a PDF using all available strategies.
 *
 * @param {string} inputPath   Path to the uploaded temp file.
 * @returns {Buffer}           Repaired PDF buffer.
 * @throws                     Error if all strategies fail.
 */
async function repairPdf(inputPath) {
  const strategies = [
    { name: "qpdf", fn: repairWithQpdf },
    { name: "Ghostscript", fn: repairWithGhostscript },
    { name: "pdf-lib", fn: repairWithPdfLib },
  ];

  for (const { name, fn } of strategies) {
    console.log(`[PdfRepairService] Trying ${name}...`);
    const result = await fn(inputPath);
    if (result && result.length > 0) {
      console.log(
        `[PdfRepairService] ${name} succeeded (${result.length} bytes)`,
      );
      return { buffer: result, strategy: name };
    }
  }

  throw new Error(
    "All repair strategies failed. The file may be beyond recovery.",
  );
}

module.exports = { repairPdf };
