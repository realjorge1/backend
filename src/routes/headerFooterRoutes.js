const express = require("express");
const router = express.Router();
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fs = require("fs").promises;
const { safeLoadPDF } = require("../services/pdfService");

/**
 * POST /api/header-footer
 * Enhanced header/footer with:
 *   - Three-column layout (left/center/right)
 *   - Token substitution: {page}, {total}, {date}, {title}
 *   - Optional logo image
 *   - Separator lines
 *   - Page range control
 *   - Font size and color customization
 *
 * Returns: modified PDF binary
 */
router.post("/", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const b = req.body;

  const headerEnabled = b.headerEnabled !== "false";
  const footerEnabled = b.footerEnabled !== "false";

  const headerLeft = b.headerLeft || "";
  const headerCenter = b.headerCenter || "";
  const headerRight = b.headerRight || "";
  const footerLeft = b.footerLeft || "";
  const footerCenter = b.footerCenter || "{page} / {total}";
  const footerRight = b.footerRight || "";

  const headerFontSize = parseFloat(b.headerFontSize) || 10;
  const footerFontSize = parseFloat(b.footerFontSize) || 10;
  const headerMargin = parseFloat(b.headerMargin) || 20;
  const footerMargin = parseFloat(b.footerMargin) || 20;
  const headerLine = b.headerLine !== "false";
  const footerLine = b.footerLine !== "false";
  const headerColor = hexToRgb(b.headerColor || "#000000");
  const footerColor = hexToRgb(b.footerColor || "#000000");

  try {
    const pdfBytes = await fs.readFile(req.files.pdf.tempFilePath);
    const pdfDoc = await safeLoadPDF(pdfBytes, {
      ignoreEncryption: true,
    });
    const pages = pdfDoc.getPages();
    const total = pages.length;
    const title = pdfDoc.getTitle() || "";
    const today = new Date().toLocaleDateString("en-GB");

    const startPage = Math.max(1, parseInt(b.startPage) || 1) - 1;
    const endPage = Math.min(total, parseInt(b.endPage) || total) - 1;

    // Embed fonts
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Embed logo if provided
    let logoEmbed = null;
    const logoFile = req.files?.logoImage || req.files?.logo;
    if (logoFile) {
      const logoBuf = await fs.readFile(logoFile.tempFilePath);
      const ext = (logoFile.name || "").split(".").pop().toLowerCase();
      logoEmbed =
        ext === "png"
          ? await pdfDoc.embedPng(logoBuf)
          : await pdfDoc.embedJpg(logoBuf);
    }

    let modified = 0;

    for (let pi = startPage; pi <= endPage; pi++) {
      const page = pages[pi];
      const { width, height } = page.getSize();
      const pageNum = pi + 1;

      const tokenise = (text) =>
        text
          .replace(/\{page\}/gi, String(pageNum))
          .replace(/\{total\}/gi, String(total))
          .replace(/\{date\}/gi, today)
          .replace(/\{title\}/gi, title);

      // ── HEADER ──────────────────────────────────────────────────────────
      if (
        headerEnabled &&
        (headerLeft || headerCenter || headerRight || logoEmbed)
      ) {
        const hColor = rgb(
          headerColor.r / 255,
          headerColor.g / 255,
          headerColor.b / 255,
        );
        const lineY = height - headerMargin - headerFontSize - 4;

        drawThreeColumns(page, font, {
          left: tokenise(headerLeft),
          center: tokenise(headerCenter),
          right: tokenise(headerRight),
          y: height - headerMargin - headerFontSize,
          fontSize: headerFontSize,
          color: hColor,
          width,
        });

        if (headerLine) {
          page.drawLine({
            start: { x: headerMargin, y: lineY },
            end: { x: width - headerMargin, y: lineY },
            thickness: 0.5,
            color: hColor,
          });
        }

        // Logo in top-left
        if (logoEmbed) {
          const logoH = headerFontSize * 2;
          const logoW = logoH * (logoEmbed.width / logoEmbed.height);
          page.drawImage(logoEmbed, {
            x: headerMargin,
            y: height - headerMargin - logoH,
            width: logoW,
            height: logoH,
          });
        }
      }

      // ── FOOTER ──────────────────────────────────────────────────────────
      if (
        footerEnabled &&
        (footerLeft || footerCenter || footerRight)
      ) {
        const fColor = rgb(
          footerColor.r / 255,
          footerColor.g / 255,
          footerColor.b / 255,
        );
        const lineY = footerMargin + footerFontSize + 4;

        if (footerLine) {
          page.drawLine({
            start: { x: footerMargin, y: lineY },
            end: { x: width - footerMargin, y: lineY },
            thickness: 0.5,
            color: fColor,
          });
        }

        drawThreeColumns(page, font, {
          left: tokenise(footerLeft),
          center: tokenise(footerCenter),
          right: tokenise(footerRight),
          y: footerMargin,
          fontSize: footerFontSize,
          color: fColor,
          width,
        });
      }

      modified++;
    }

    const outBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=header-footer.pdf",
    );
    res.send(Buffer.from(outBytes));
  } catch (err) {
    next(err);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function drawThreeColumns(
  page,
  font,
  { left, center, right, y, fontSize, color, width },
) {
  const margin = 20;
  if (left) {
    page.drawText(left, { x: margin, y, size: fontSize, font, color });
  }
  if (center) {
    const textW = font.widthOfTextAtSize(center, fontSize);
    page.drawText(center, {
      x: (width - textW) / 2,
      y,
      size: fontSize,
      font,
      color,
    });
  }
  if (right) {
    const textW = font.widthOfTextAtSize(right, fontSize);
    page.drawText(right, {
      x: width - textW - margin,
      y,
      size: fontSize,
      font,
      color,
    });
  }
}

function hexToRgb(hex) {
  const c = hex.replace("#", "");
  return {
    r: parseInt(c.substring(0, 2), 16),
    g: parseInt(c.substring(2, 4), 16),
    b: parseInt(c.substring(4, 6), 16),
  };
}

module.exports = router;
