const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const OUTPUTS_DIR = path.join(os.tmpdir(), "docu-assistant-outputs");

// Ensure directories exist
fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

/**
 * Returns a unique output file path for a given extension.
 */
function outputPath(ext = ".pdf") {
  const id = crypto.randomUUID();
  return path.join(OUTPUTS_DIR, `${id}${ext}`);
}

/**
 * Returns a unique temp file path.
 */
function tempFilePath(ext = ".pdf") {
  return path.join(OUTPUTS_DIR, `tmp_${crypto.randomUUID()}${ext}`);
}

/**
 * Converts an absolute server path to a download URL.
 */
function toDownloadUrl(req, absPath) {
  const rel = path.relative(OUTPUTS_DIR, absPath).replace(/\\/g, "/");
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/outputs/${rel}`;
}

/**
 * Safely remove files.
 */
async function cleanupFiles(...filePaths) {
  for (const fp of filePaths) {
    if (!fp) continue;
    try {
      await fs.promises.unlink(fp);
    } catch {
      // ignore
    }
  }
}

/**
 * Periodic cleanup of output files older than 1 hour.
 */
function startOutputCleanup(intervalMs = 3600000) {
  setInterval(async () => {
    try {
      const files = await fs.promises.readdir(OUTPUTS_DIR);
      const now = Date.now();
      for (const file of files) {
        const fp = path.join(OUTPUTS_DIR, file);
        try {
          const stat = await fs.promises.stat(fp);
          if (now - stat.mtimeMs > 3600000) {
            await fs.promises.unlink(fp);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }, intervalMs);
}

module.exports = {
  OUTPUTS_DIR,
  outputPath,
  tempFilePath,
  toDownloadUrl,
  cleanupFiles,
  startOutputCleanup,
};
