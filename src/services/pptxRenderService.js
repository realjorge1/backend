// ============================================================================
// PPTX Render Service (isolated)
//
// Converts .pptx / .ppt files to PDF via LibreOffice headless so the mobile
// client can display them through its existing react-native-pdf viewer.
//
// LibreOffice is the ONLY engine. There is deliberately no fallback: the old
// text-extraction fallback (AdmZip + PDFKit) produced unacceptable output
// while reporting success. If LibreOffice is missing or fails, callers get a
// typed error (statusCode 503) and must surface it honestly.
//
// Intentionally self-contained — does NOT import officeConversionService or
// any other shared converter. No coupling with PDF / DOCX / EPUB subsystems.
// ============================================================================

const { execFile } = require("child_process");
const util = require("util");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { OUTPUTS_DIR } = require("../utils/fileOutputUtils");
const { withLibreOfficeLock } = require("../utils/loQueue");
const logger = require("../utils/logger");

const execFileAsync = util.promisify(execFile);

const CONVERSION_TIMEOUT_MS = 120_000; // 2 min hard ceiling per job
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const MAX_INPUT_BYTES = 100 * 1024 * 1024; // 100 MB upper bound guard
const HASH_ALGO = "sha256";

// ── Typed errors ─────────────────────────────────────────────────────────────

class EngineUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "EngineUnavailableError";
    this.code = "ENGINE_UNAVAILABLE";
    this.statusCode = 503;
  }
}

class ConversionFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversionFailedError";
    this.code = "CONVERSION_FAILED";
    this.statusCode = 503;
  }
}

class InvalidInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidInputError";
    this.code = "INVALID_INPUT";
    this.statusCode = 400;
  }
}

// ── LibreOffice binary resolution ───────────────────────────────────────────

const CANDIDATE_BINARIES = [
  process.env.LIBREOFFICE_PATH,
  "soffice",
  "libreoffice",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/opt/libreoffice/program/soffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
  "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
].filter(Boolean);

let cachedEngine = null; // { binary, version }

function parseVersion(stdout) {
  // "LibreOffice 7.4.7.2 40(Build:2)" → "LibreOffice 7.4.7.2"
  const m = String(stdout || "").match(/LibreOffice\s+[\d.]+/i);
  return m ? m[0] : null;
}

async function probeVersion(binary) {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseVersion(stdout);
  } catch {
    return null;
  }
}

/**
 * Locate the LibreOffice binary and cache it together with its version
 * string (from `soffice --version`, probed once at first resolution).
 * Throws EngineUnavailableError when no binary is usable.
 */
async function getEngineInfo() {
  if (cachedEngine) return cachedEngine;

  for (const candidate of CANDIDATE_BINARIES) {
    try {
      if (path.isAbsolute(candidate)) {
        await fsp.access(candidate, fs.constants.X_OK);
        cachedEngine = {
          binary: candidate,
          version: await probeVersion(candidate),
        };
        return cachedEngine;
      }
      // Bare command name — the version probe doubles as the existence check
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        timeout: VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      cachedEngine = { binary: candidate, version: parseVersion(stdout) };
      return cachedEngine;
    } catch {
      // try next candidate
    }
  }
  throw new EngineUnavailableError(
    "LibreOffice not found. Install LibreOffice and/or set LIBREOFFICE_PATH env var.",
  );
}

async function resolveLibreOffice() {
  return (await getEngineInfo()).binary;
}

// ── Validation helpers ──────────────────────────────────────────────────────

function assertPptxExtension(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext !== ".pptx" && ext !== ".ppt") {
    throw new InvalidInputError(`Unsupported file extension: ${ext || "(none)"}`);
  }
}

function getOriginalExtension(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return ext === ".ppt" ? ".ppt" : ".pptx";
}

async function assertReadable(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new InvalidInputError("Input is not a regular file");
  if (stat.size === 0) throw new InvalidInputError("Input file is empty");
  if (stat.size > MAX_INPUT_BYTES) {
    throw new InvalidInputError(
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

// ── LibreOffice invocation ──────────────────────────────────────────────────

/**
 * Run one `soffice --convert-to pdf` job in a throwaway profile + work dir.
 * Must be called under withLibreOfficeLock(). Returns the path of the PDF
 * inside workDir; the caller copies it out and then removes workDir. The
 * profile dir is always removed here; on failure workDir is removed too.
 */
async function sofficeConvert(binary, inputPath, ext, outputBaseName) {
  const jobId = crypto.randomUUID();
  // Unique profile per job avoids LibreOffice profile-lock failures; unique
  // work dir keeps concurrent request files apart and makes cleanup trivial.
  const profileDir = path.join(os.tmpdir(), `lo-profile-${jobId}`);
  const workDir = path.join(os.tmpdir(), `lo-work-${jobId}`);

  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.mkdir(workDir, { recursive: true });

  try {
    const namedInput = path.join(workDir, `${outputBaseName}${ext}`);
    await fsp.copyFile(inputPath, namedInput);

    try {
      await execFileAsync(
        binary,
        [
          `-env:UserInstallation=${toFileUrl(profileDir)}`,
          "--headless",
          "--invisible",
          "--nodefault",
          "--norestore",
          "--nolockcheck",
          "--nologo",
          "--nofirststartwizard",
          "--convert-to",
          "pdf",
          "--outdir",
          workDir,
          namedInput,
        ],
        {
          timeout: CONVERSION_TIMEOUT_MS,
          killSignal: "SIGKILL", // guarantee the process dies on expiry
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (err) {
      if (err.killed || err.signal) {
        throw new ConversionFailedError(
          `LibreOffice timed out after ${CONVERSION_TIMEOUT_MS / 1000}s and was killed`,
        );
      }
      const stderr = (err.stderr || "").toString().trim().slice(0, 500);
      throw new ConversionFailedError(
        `LibreOffice failed: ${stderr || err.message}`,
      );
    }

    const producedPdf = path.join(workDir, `${outputBaseName}.pdf`);
    let stat;
    try {
      stat = await fsp.stat(producedPdf);
    } catch {
      const files = await fsp.readdir(workDir).catch(() => []);
      throw new ConversionFailedError(
        `LibreOffice produced no PDF (workDir contains: ${files.join(", ") || "empty"})`,
      );
    }
    if (stat.size === 0) {
      throw new ConversionFailedError("LibreOffice produced an empty PDF");
    }

    return producedPdf;
  } catch (err) {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertToCachedPdf(binary, inputPath, ext, fileHash) {
  const producedPdf = await sofficeConvert(binary, inputPath, ext, "input");
  const workDir = path.dirname(producedPdf);
  try {
    const finalPath = cachedPdfPath(fileHash);
    await fsp.copyFile(producedPdf, finalPath);
    const stat = await fsp.stat(finalPath);
    return { id: fileHash, pdfPath: finalPath, sizeBytes: stat.size };
  } finally {
    fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Core conversion ─────────────────────────────────────────────────────────

/**
 * Convert a .pptx/.ppt file on disk to a PDF, stored in OUTPUTS_DIR.
 * Returns the absolute path to the generated PDF and its id.
 *
 * Uses hash-based caching: if the same file was converted before and the PDF
 * is still on disk, the cached copy is returned instantly.
 *
 * Throws:
 *   InvalidInputError      (400) — bad extension / empty / oversized input
 *   EngineUnavailableError (503) — LibreOffice not installed
 *   ConversionFailedError  (503) — LibreOffice crashed, timed out, or
 *                                  produced no usable PDF
 *
 * @param {string} inputPath  absolute path to the source .pptx (temp file)
 * @param {string} [originalName] original filename — used for extension detection
 * @returns {Promise<{ id: string, pdfPath: string, sizeBytes: number }>}
 */
async function renderPptxToPdf(inputPath, originalName) {
  if (!inputPath) throw new InvalidInputError("inputPath is required");
  assertPptxExtension(originalName || inputPath);
  await assertReadable(inputPath);

  // ── Check cache ─────────────────────────────────────────────────
  const fileHash = await hashFile(inputPath);
  const cached = await getCachedPdf(fileHash);
  if (cached) {
    return { id: fileHash, pdfPath: cached.pdfPath, sizeBytes: cached.sizeBytes };
  }

  // ── Convert via LibreOffice (the only engine — no fallback) ─────
  const { binary } = await getEngineInfo();
  const ext = getOriginalExtension(originalName || inputPath);

  return withLibreOfficeLock(async () => {
    // Re-check the cache: an identical file may have been converted while
    // this job sat in the queue.
    const nowCached = await getCachedPdf(fileHash);
    if (nowCached) {
      return { id: fileHash, pdfPath: nowCached.pdfPath, sizeBytes: nowCached.sizeBytes };
    }
    return convertToCachedPdf(binary, inputPath, ext, fileHash);
  });
}

// ── Boot warm-up ────────────────────────────────────────────────────────────

/**
 * Run one trivial conversion at server start so the first real request does
 * not pay LibreOffice's first-run initialization cost (binary + library load,
 * font cache). Failure is non-fatal: it just logs a warning, and /api/pptx
 * endpoints keep reporting an honest 503 until LibreOffice is available.
 */
async function warmUpLibreOffice() {
  const startedAt = Date.now();
  try {
    const { binary, version } = await getEngineInfo();
    const seed = path.join(os.tmpdir(), `lo-warmup-${crypto.randomUUID()}.txt`);
    await fsp.writeFile(seed, "warm-up\n", "utf8");
    try {
      const producedPdf = await withLibreOfficeLock(() =>
        sofficeConvert(binary, seed, ".txt", "warmup"),
      );
      await fsp.rm(path.dirname(producedPdf), { recursive: true, force: true });
    } finally {
      fsp.rm(seed, { force: true }).catch(() => {});
    }
    logger.info("[pptx] LibreOffice warm-up complete", {
      engine: version || "unknown version",
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    logger.warn(`[pptx] LibreOffice warm-up skipped: ${err.message}`);
  }
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
  getEngineInfo,
  warmUpLibreOffice,
  EngineUnavailableError,
  ConversionFailedError,
  InvalidInputError,
};
