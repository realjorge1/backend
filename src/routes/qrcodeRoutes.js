const express = require("express");
const router = express.Router();
const { PDFDocument } = require("pdf-lib");
const QRCode = require("qrcode");
const sharp = require("sharp");
const fs = require("fs").promises;
const { tempFilePath, outputPath, toDownloadUrl, cleanupFiles } = require("../utils/fileOutputUtils");
const { validateOutputChanged } = require("../utils/processingValidator");
const { safeLoadPDF } = require("../services/pdfService");

/**
 * POST /api/qrcode
 * Body: multipart/form-data
 *   pdf, data, pages, position, size, margin, qrColor, bgColor, errorLevel
 *
 * Generates a QR code PNG and embeds it into the PDF at the specified position.
 * Validates output differs from input.
 * Returns: modified PDF binary
 */
router.post("/", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const data = req.body.data;
  if (!data) {
    return res.status(400).json({ error: "QR data is required" });
  }

  const pagesParam = req.body.pages || "all";
  const position = req.body.position || "bottom-right";
  const qrSize = parseInt(req.body.size) || 80;
  const margin = parseInt(req.body.margin) || 20;
  const qrColor = req.body.qrColor || "#000000";
  const bgColor = req.body.bgColor || "#ffffff";
  const errorLevel = req.body.errorLevel || "M";
  const transparent = bgColor === "transparent";

  const tempQr = tempFilePath(".png");

  try {
    // Generate QR PNG
    const qrPxSize = qrSize * 3;
    await QRCode.toFile(tempQr, data, {
      type: "png",
      width: qrPxSize,
      margin: 2,
      errorCorrectionLevel: errorLevel,
      color: {
        dark: qrColor,
        light: transparent ? "#ffffff00" : bgColor,
      },
    });

    let qrBuffer = await fs.readFile(tempQr);
    if (transparent) {
      qrBuffer = await sharp(qrBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data: raw, info }) => {
          for (let i = 0; i < raw.length; i += 4) {
            if (raw[i] > 240 && raw[i + 1] > 240 && raw[i + 2] > 240) {
              raw[i + 3] = 0;
            }
          }
          return sharp(raw, {
            raw: {
              width: info.width,
              height: info.height,
              channels: 4,
            },
          })
            .png()
            .toBuffer();
        });
    }

    // Load PDF & embed QR
    const pdfBytes = await fs.readFile(req.files.pdf.tempFilePath);
    const pdfDoc = await safeLoadPDF(pdfBytes, {
      ignoreEncryption: true,
    });
    const pages = pdfDoc.getPages();

    const qrImage = await pdfDoc.embedPng(qrBuffer);
    let modified = 0;

    const targetPages = resolvePageList(pagesParam, pages.length);

    if (targetPages.length === 0) {
      await cleanupFiles(tempQr);
      return res.status(400).json({ error: "No valid target pages specified" });
    }

    for (const pi of targetPages) {
      const page = pages[pi];
      const { width, height } = page.getSize();
      const { x, y } = calcPosition(
        position,
        width,
        height,
        qrSize,
        margin,
      );

      page.drawImage(qrImage, {
        x,
        y,
        width: qrSize,
        height: qrSize,
      });
      modified++;
    }

    const outBytes = await pdfDoc.save();
    const outBuffer = Buffer.from(outBytes);
    await cleanupFiles(tempQr);

    // Validate output actually changed
    validateOutputChanged(pdfBytes, outBuffer, "QR Code Embed");

    // Save to output file and return download URL
    const outFilePath = outputPath(".pdf");
    await fs.writeFile(outFilePath, outBuffer);

    return res.json({
      success: true,
      downloadUrl: toDownloadUrl(req, outFilePath),
      filename: "qr-added.pdf",
      pagesModified: modified,
    });
  } catch (err) {
    await cleanupFiles(tempQr);
    next(err);
  }
});

/**
 * POST /api/qrcode/preview
 * Body: JSON { data, size?, errorLevel?, qrColor?, bgColor? }
 * Returns: PNG image
 */
router.post("/preview", express.json(), async (req, res, next) => {
  const {
    data,
    size = 200,
    errorLevel = "M",
    qrColor = "#000000",
    bgColor = "#ffffff",
  } = req.body;
  if (!data) {
    return res.status(400).json({ error: "data is required" });
  }

  const tempQr = tempFilePath(".png");
  try {
    await QRCode.toFile(tempQr, data, {
      type: "png",
      width: size,
      margin: 2,
      errorCorrectionLevel: errorLevel,
      color: { dark: qrColor, light: bgColor },
    });

    const buf = await fs.readFile(tempQr);
    res.set("Content-Type", "image/png");
    res.send(buf);
    await cleanupFiles(tempQr);
  } catch (err) {
    await cleanupFiles(tempQr);
    next(err);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePageList(pagesParam, total) {
  if (pagesParam === "all")
    return Array.from({ length: total }, (_, i) => i);
  if (pagesParam === "first") return [0];
  if (pagesParam === "last") return [total - 1];

  const result = new Set();
  for (const part of pagesParam.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [startStr, endStr] = trimmed.split("-");
      const start = parseInt(startStr) - 1;
      const end = parseInt(endStr) - 1;
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(0, start); i <= Math.min(total - 1, end); i++) {
          result.add(i);
        }
      }
    } else {
      const p = parseInt(trimmed) - 1;
      if (!isNaN(p) && p >= 0 && p < total) result.add(p);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function calcPosition(position, pageW, pageH, qrSize, margin) {
  switch (position) {
    case "top-left":
      return { x: margin, y: pageH - qrSize - margin };
    case "top-right":
      return { x: pageW - qrSize - margin, y: pageH - qrSize - margin };
    case "bottom-left":
      return { x: margin, y: margin };
    case "bottom-right":
      return { x: pageW - qrSize - margin, y: margin };
    case "center":
      return {
        x: (pageW - qrSize) / 2,
        y: (pageH - qrSize) / 2,
      };
    default:
      return { x: pageW - qrSize - margin, y: margin };
  }
}

module.exports = router;
