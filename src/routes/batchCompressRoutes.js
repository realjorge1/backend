const express = require("express");
const router = express.Router();
const { PDFDocument, PDFName, PDFStream } = require("pdf-lib");
const sharp = require("sharp");
const fs = require("fs").promises;
const {
  outputPath,
  toDownloadUrl,
} = require("../utils/fileOutputUtils");
const pdfRepairService = require("../services/pdfRepairService");

// Load a PDF buffer with structural-repair fallback (mirrors safeLoadPDF in pdfService.js)
async function loadWithFallback(pdfBytes, inputPath) {
  const opts = { ignoreEncryption: true, throwOnInvalidObject: false };
  if (pdfBytes.slice(0, 5).toString("binary") === "%PDF-") {
    try { return await PDFDocument.load(pdfBytes, opts); } catch {}
  }
  // Repair fallback
  const { buffer } = await pdfRepairService.repairPdf(inputPath);
  const repaired = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return PDFDocument.load(repaired, opts);
}

const LEVELS = {
  low: { quality: 85, scale: 1.0 },
  medium: { quality: 65, scale: 0.85 },
  high: { quality: 45, scale: 0.7 },
};

/**
 * POST /api/batch-compress
 * Body: multipart/form-data
 *   pdfs[] : File[] (or single pdf)
 *   compressionLevel : "low" | "medium" | "high" (default: medium)
 *
 * Returns: { results: [{ originalName, originalSize, compressedSize, reduction, url }] }
 */
router.post("/", async (req, res, next) => {
  if (!req.files?.pdfs && !req.files?.pdf) {
    return res.status(400).json({ error: "No PDFs uploaded" });
  }

  // Normalize to array
  let files = req.files.pdfs || req.files.pdf;
  if (!Array.isArray(files)) files = [files];

  const level = LEVELS[req.body.compressionLevel] || LEVELS.medium;
  const results = [];

  try {
    for (const file of files) {
      const inputPath = file.tempFilePath;
      const originalSize = file.size;

      const pdfBytes = await fs.readFile(inputPath);
      const pdfDoc = await loadWithFallback(pdfBytes, inputPath);

      // Strip metadata
      pdfDoc.setTitle("");
      pdfDoc.setAuthor("");
      pdfDoc.setSubject("");
      pdfDoc.setKeywords([]);
      pdfDoc.setCreator("Inscribed");
      pdfDoc.setProducer("Inscribed");

      // Re-compress embedded JPEG images
      const context = pdfDoc.context;
      let imagesProcessed = 0;
      for (const [, obj] of context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFStream)) continue;

        const dict = obj.dict;
        const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
        const filter = dict.lookupMaybe(PDFName.of("Filter"), PDFName);

        if (subtype?.toString() !== "/Image") continue;
        if (!filter || filter.toString() !== "/DCTDecode") continue;

        const width =
          dict.lookupMaybe(PDFName.of("Width"))?.asNumber() || 0;
        const height =
          dict.lookupMaybe(PDFName.of("Height"))?.asNumber() || 0;
        if (!width || !height) continue;

        try {
          const imgData = obj.getContents();
          const newW = Math.max(1, Math.round(width * level.scale));
          const newH = Math.max(1, Math.round(height * level.scale));

          const recompressed = await sharp(imgData)
            .resize(newW, newH)
            .jpeg({ quality: level.quality, mozjpeg: true })
            .toBuffer();

          if (recompressed.length < imgData.length) {
            obj.setContents(recompressed);
            dict.set(PDFName.of("Width"), context.obj(newW));
            dict.set(PDFName.of("Height"), context.obj(newH));
            imagesProcessed++;
          }
        } catch {
          // Skip images that can't be re-encoded
        }
        // Yield every 8 images to keep the event loop responsive
        if (imagesProcessed > 0 && imagesProcessed % 8 === 0) {
          await new Promise((r) => setImmediate(r));
        }
      }

      const compressedBytes = await pdfDoc.save({
        useObjectStreams: true,
        addDefaultPage: false,
        objectsPerTick: 50,
      });

      const outPath = outputPath(".pdf");
      await fs.writeFile(outPath, compressedBytes);
      const compressedSize = (await fs.stat(outPath)).size;

      const reduction = (
        ((originalSize - compressedSize) / originalSize) *
        100
      ).toFixed(1);

      results.push({
        originalName: file.name,
        originalSize,
        compressedSize,
        reduction: `${reduction}%`,
        url: toDownloadUrl(req, outPath),
      });
    }

    return res.json({ results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
