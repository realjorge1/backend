// ============================================================================
// PPTX Render Service (isolated)
//
// Converts .pptx / .ppt files to PDF via LibreOffice headless so the mobile
// client can display them through its existing react-native-pdf viewer.
//
// Intentionally self-contained — does NOT import officeConversionService or
// any other shared converter. No coupling with PDF / DOCX / EPUB subsystems.
// ============================================================================

const { execFile } = require("child_process");
const util = require("util");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const { OUTPUTS_DIR } = require("../utils/fileOutputUtils");
const logger = require("../utils/logger");

const execFileAsync = util.promisify(execFile);

const CONVERSION_TIMEOUT_MS = 120_000; // 2 min hard ceiling per job
const MAX_INPUT_BYTES = 100 * 1024 * 1024; // 100 MB upper bound guard
const HASH_ALGO = "sha256";

// ── LibreOffice binary resolution ───────────────────────────────────────────

const CANDIDATE_BINARIES = [
  process.env.LIBREOFFICE_PATH,
  "soffice",
  "libreoffice",
  "/usr/bin/libreoffice",
  "/usr/bin/soffice",
  "/opt/libreoffice/program/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
].filter(Boolean);

let cachedBinaryPath = null;

async function resolveLibreOffice() {
  if (cachedBinaryPath) return cachedBinaryPath;

  for (const candidate of CANDIDATE_BINARIES) {
    try {
      if (path.isAbsolute(candidate)) {
        await fsp.access(candidate, fs.constants.X_OK);
        cachedBinaryPath = candidate;
        return candidate;
      }
      await execFileAsync(candidate, ["--version"], { timeout: 5000 });
      cachedBinaryPath = candidate;
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    "LibreOffice not found. Install LibreOffice and/or set LIBREOFFICE_PATH env var.",
  );
}

// ── Validation helpers ──────────────────────────────────────────────────────

function assertPptxExtension(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext !== ".pptx" && ext !== ".ppt") {
    throw new Error(`Unsupported file extension: ${ext || "(none)"}`);
  }
}

function getOriginalExtension(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return ext === ".ppt" ? ".ppt" : ".pptx";
}

async function assertReadable(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error("Input is not a regular file");
  if (stat.size === 0) throw new Error("Input file is empty");
  if (stat.size > MAX_INPUT_BYTES) {
    throw new Error(
      `Input file too large (${stat.size} bytes, max ${MAX_INPUT_BYTES})`,
    );
  }
}

// ── Hash-based cache ────────────────────────────────────────────────────────
// Key = SHA-256 of file contents. If a PDF for that hash already exists in
// OUTPUTS_DIR we skip conversion entirely and return it.

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(HASH_ALGO);
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function cachedPdfPath(fileHash) {
  return path.join(OUTPUTS_DIR, `pptx_${fileHash}.pdf`);
}

async function getCachedPdf(fileHash) {
  const p = cachedPdfPath(fileHash);
  try {
    const stat = await fsp.stat(p);
    if (stat.isFile() && stat.size > 0) return { pdfPath: p, sizeBytes: stat.size };
  } catch {
    // not cached
  }
  return null;
}

// ── File URL helper (LibreOffice UserInstallation) ──────────────────────────
// POSIX paths start with "/" → file:///tmp/… (two slashes + absolute path)
// Windows paths start with "C:/" → file:///C:/… (three slashes + drive)

function toFileUrl(absPath) {
  const normalized = absPath.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

// ── Core conversion ─────────────────────────────────────────────────────────

/**
 * Convert a .pptx/.ppt file on disk to a PDF, stored in OUTPUTS_DIR.
 * Returns the absolute path to the generated PDF and its id.
 *
 * Uses hash-based caching: if the same file was converted before and the PDF
 * is still on disk, the cached copy is returned instantly.
 *
 * @param {string} inputPath  absolute path to the source .pptx (temp file)
 * @param {string} [originalName] original filename — used for extension detection
 * @returns {Promise<{ id: string, pdfPath: string, sizeBytes: number }>}
 */
async function renderPptxToPdf(inputPath, originalName) {
  if (!inputPath) throw new Error("inputPath is required");
  assertPptxExtension(originalName || inputPath);
  await assertReadable(inputPath);

  // ── Check cache ─────────────────────────────────────────────────
  const fileHash = await hashFile(inputPath);
  const cached = await getCachedPdf(fileHash);
  if (cached) {
    return { id: fileHash, pdfPath: cached.pdfPath, sizeBytes: cached.sizeBytes };
  }

  // ── Try LibreOffice first ────────────────────────────────────────
  let pdfBuffer = null;

  try {
    const binary = await resolveLibreOffice();

    const jobId = crypto.randomUUID();
    const profileDir = path.join(OUTPUTS_DIR, `lo_profile_${jobId}`);
    const workDir = path.join(OUTPUTS_DIR, `lo_work_${jobId}`);

    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.mkdir(workDir, { recursive: true });

    const ext = getOriginalExtension(originalName || inputPath);
    const namedInput = path.join(workDir, `input${ext}`);
    await fsp.copyFile(inputPath, namedInput);

    try {
      await execFileAsync(
        binary,
        [
          `-env:UserInstallation=${toFileUrl(profileDir)}`,
          "--headless",
          "--norestore",
          "--nologo",
          "--nodefault",
          "--nofirststartwizard",
          "--convert-to",
          "pdf",
          "--outdir",
          workDir,
          namedInput,
        ],
        { timeout: CONVERSION_TIMEOUT_MS, windowsHide: true },
      );

      const producedPdf = path.join(workDir, "input.pdf");
      if (!fs.existsSync(producedPdf)) {
        const files = await fsp.readdir(workDir).catch(() => []);
        throw new Error(
          `LibreOffice produced no PDF (workDir contains: ${files.join(", ") || "empty"})`,
        );
      }
      pdfBuffer = await fsp.readFile(producedPdf);
    } finally {
      fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (loErr) {
    // LibreOffice not installed or failed — fall back to pure-JS converter
    logger.warn(`[pptx] LibreOffice unavailable (${loErr.message}), using JS fallback`);
  }

  // ── JS fallback: AdmZip + PDFKit (no system deps required) ──────
  if (!pdfBuffer) {
    const officeService = require("./officeConversionService");
    pdfBuffer = await officeService.pptToPDF({
      tempFilePath: inputPath,
      name: originalName || path.basename(inputPath),
    });
  }

  // ── Persist to hash-keyed cache ──────────────────────────────────
  const finalPath = cachedPdfPath(fileHash);
  await fsp.writeFile(finalPath, pdfBuffer);
  const stat = await fsp.stat(finalPath);
  return { id: fileHash, pdfPath: finalPath, sizeBytes: stat.size };
}

/**
 * Resolve a previously-rendered PDF by id (hash). Returns null if it's no
 * longer on disk (e.g. cleaned up by startOutputCleanup after 1 h).
 */
async function getRenderedPdfPath(id) {
  if (!id || typeof id !== "string") return null;
  // Accept both UUID-style ids (legacy) and hex hashes
  if (!/^[a-f0-9-]{8,}$/i.test(id)) return null;

  // Try hash-keyed path first, fall back to UUID-keyed path
  const candidates = [
    path.join(OUTPUTS_DIR, `pptx_${id}.pdf`),
    path.join(OUTPUTS_DIR, `${id}.pdf`),
  ];

  for (const p of candidates) {
    try {
      const stat = await fsp.stat(p);
      if (stat.isFile() && stat.size > 0) return p;
    } catch {
      // try next
    }
  }
  return null;
}

module.exports = {
  renderPptxToPdf,
  getRenderedPdfPath,
  resolveLibreOffice,
};
