// ============================================================================
// PPTX Routes (isolated)
//
// /api/pptx/render        POST   upload .pptx, stream back rendered PDF
// /api/pptx/convert       POST   upload .pptx, return { id } for later fetch
// /api/pptx/stream/:id    GET    stream a previously-rendered PDF inline
// /api/pptx/download/:id  GET    download a previously-rendered PDF as file
// /api/pptx/health        GET    reports whether LibreOffice is reachable
//
// No coupling with pdfRoutes / convertRoutes / documentRoutes.
// ============================================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");
const {
  renderPptxToPdf,
  getRenderedPdfPath,
  resolveLibreOffice,
} = require("../services/pptxRenderService");

const router = express.Router();

// ── Helpers ────────���─────────────────���──────────────────────────────────────

function getUploadedPptx(req) {
  if (!req.files) return null;
  return (
    req.files.file ||
    req.files.document ||
    req.files.pptx ||
    req.files.upload ||
    null
  );
}

function safePdfName(originalName) {
  const base = path.basename(
    originalName || "presentation",
    path.extname(originalName || ""),
  );
  // Strip characters that are unsafe in Content-Disposition
  return base.replace(/[^\w. -]/g, "_") + ".pdf";
}

function sendPdf(res, pdfPath, { inline, downloadName }) {
  const stat = fs.statSync(pdfPath);
  const safeName = (downloadName || "presentation.pdf").replace(/[\r\n"]/g, "");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", stat.size);
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
  );
  res.setHeader("Cache-Control", "private, max-age=300");
  fs.createReadStream(pdfPath).pipe(res);
}

// --- POST /api/pptx/render --------------------------------------------------
// Synchronous: upload + convert + stream PDF in one round-trip.
router.post("/render", async (req, res) => {
  try {
    const file = getUploadedPptx(req);
    if (!file) {
      return res
        .status(400)
        .json({ error: "No PPTX file uploaded (expected field 'file')" });
    }

    logger.info("[pptx] /render start", { name: file.name, size: file.size });

    const { pdfPath } = await renderPptxToPdf(file.tempFilePath, file.name);
    const downloadName = safePdfName(file.name);

    res.setHeader("X-PPTX-Cached", "false");
    sendPdf(res, pdfPath, { inline: true, downloadName });
  } catch (err) {
    logger.error("[pptx] /render failed", { error: err.message });
    res.status(500).json({
      error: "PPTX render failed",
      details: err.message,
      hint: "Ensure LibreOffice is installed on the server (LIBREOFFICE_PATH env var).",
    });
  }
});

// --- POST /api/pptx/convert -------------------------------------------------
// Upload + convert; respond with { id, sizeBytes } so the client can later
// stream or download the cached PDF via GET endpoints.
router.post("/convert", async (req, res) => {
  try {
    const file = getUploadedPptx(req);
    if (!file) {
      return res
        .status(400)
        .json({ error: "No PPTX file uploaded (expected field 'file')" });
    }

    logger.info("[pptx] /convert start", { name: file.name, size: file.size });

    const { id, sizeBytes } = await renderPptxToPdf(
      file.tempFilePath,
      file.name,
    );
    const downloadName = safePdfName(file.name);

    logger.info("[pptx] /convert done", { id, sizeBytes });

    res.json({
      id,
      sizeBytes,
      originalName: file.name || null,
      downloadName,
      streamUrl: `/api/pptx/stream/${id}`,
      downloadUrl: `/api/pptx/download/${id}`,
    });
  } catch (err) {
    logger.error("[pptx] /convert failed", { error: err.message });
    res.status(500).json({
      error: "PPTX conversion failed",
      details: err.message,
      hint: "Ensure LibreOffice is installed on the server (LIBREOFFICE_PATH env var).",
    });
  }
});

// --- GET /api/pptx/stream/:id ----------------------------------------------
router.get("/stream/:id", async (req, res) => {
  try {
    const pdfPath = await getRenderedPdfPath(req.params.id);
    if (!pdfPath) {
      return res.status(404).json({ error: "Render not found or expired" });
    }
    sendPdf(res, pdfPath, { inline: true, downloadName: "presentation.pdf" });
  } catch (err) {
    logger.error("[pptx] /stream failed", { error: err.message });
    res.status(500).json({ error: "Stream failed", details: err.message });
  }
});

// --- GET /api/pptx/download/:id --------------------------------------------
router.get("/download/:id", async (req, res) => {
  try {
    const pdfPath = await getRenderedPdfPath(req.params.id);
    if (!pdfPath) {
      return res.status(404).json({ error: "Render not found or expired" });
    }
    sendPdf(res, pdfPath, { inline: false, downloadName: "presentation.pdf" });
  } catch (err) {
    logger.error("[pptx] /download failed", { error: err.message });
    res.status(500).json({ error: "Download failed", details: err.message });
  }
});

// --- GET /api/pptx/health --------------------------------------------------
router.get("/health", async (_req, res) => {
  try {
    const binary = await resolveLibreOffice();
    res.json({ status: "ok", libreOffice: binary });
  } catch (err) {
    res.status(503).json({ status: "unavailable", error: err.message });
  }
});

module.exports = router;
