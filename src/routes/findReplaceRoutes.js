const express = require("express");
const router = express.Router();
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fs = require("fs").promises;
const {
  extractTextWithPositions,
  findMatches,
} = require("../utils/pdfTextExtractor");
const { validateOutputChanged } = require("../utils/processingValidator");
const { outputPath, toDownloadUrl } = require("../utils/fileOutputUtils");
const { safeLoadPDF } = require("../services/pdfService");

/**
 * POST /api/find-replace/preview
 * Returns: { matches: [{ page, snippet }], total }
 */
router.post("/preview", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const searchText = req.body.search || req.body.searchText;
  const caseSensitive = req.body.caseSensitive === "true";
  if (!searchText) {
    return res.status(400).json({ error: "search text is required" });
  }

  try {
    const { pages } = await extractTextWithPositions(
      req.files.pdf.tempFilePath,
    );

    // Check if the PDF has any extractable text at all
    const totalTextItems = pages.reduce((sum, p) => sum + p.items.length, 0);
    if (totalTextItems === 0) {
      return res.json({
        matches: [],
        total: 0,
        warning:
          "This PDF contains no extractable text. It may be a scanned document or image-based PDF.",
      });
    }

    const { matches, total } = findMatches(pages, searchText, {
      caseSensitive,
    });

    return res.json({
      matches: matches.map((m) => ({
        page: m.pageNum,
        snippet: m.matchedText,
      })),
      total,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/find-replace
 * Body: { pdf, search, replace, caseSensitive, highlightColor }
 *
 * REAL FIND & REPLACE:
 *  1. Finds all occurrences of search text with position data
 *  2. Covers each occurrence with a white rectangle (erases visual text)
 *  3. Draws replacement text at the same position
 *  4. Validates output differs from input
 * Returns: modified PDF binary
 */
router.post("/", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const searchText = req.body.search || req.body.searchText;
  const replaceText = req.body.replace ?? req.body.replaceText ?? "";
  const caseSensitive = req.body.caseSensitive === "true";
  const highlightHex = req.body.highlightColor || null;

  if (!searchText) {
    return res.status(400).json({ error: "search text is required" });
  }

  try {
    const inputPath = req.files.pdf.tempFilePath;
    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await safeLoadPDF(pdfBytes, {
      ignoreEncryption: true,
    });
    const pdfPages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const { pages } = await extractTextWithPositions(inputPath);

    // Check if the PDF has any extractable text
    const totalTextItems = pages.reduce((sum, p) => sum + p.items.length, 0);
    if (totalTextItems === 0) {
      return res.status(400).json({
        error:
          "This PDF contains no extractable text. It may be a scanned document or image-based PDF. Find & Replace only works with text-based PDFs.",
      });
    }

    const { matches } = findMatches(pages, searchText, { caseSensitive });

    if (matches.length === 0) {
      return res
        .status(404)
        .json({ error: "No matches found for the given search text" });
    }

    let replacements = 0;

    for (const match of matches) {
      const page = pdfPages[match.pageIdx];
      if (!page) continue;

      // Compute bounding box that covers ALL regions of this match
      let coverMinX = Infinity, coverMinY = Infinity;
      let coverMaxX = -Infinity, coverMaxY = -Infinity;

      for (const region of match.regions) {
        // No horizontal padding — pad=4 was creating visible gaps between
        // the replacement and surrounding words.
        // Vertical: keep generous coverage so ascenders/descenders are hidden.
        const rx = region.x;
        const ry = region.y - region.h * 0.4;
        const rw = region.w;
        const rh = region.h * 1.5;

        coverMinX = Math.min(coverMinX, rx);
        coverMinY = Math.min(coverMinY, ry);
        coverMaxX = Math.max(coverMaxX, rx + rw);
        coverMaxY = Math.max(coverMaxY, ry + rh);

        // Cover each region individually with a white rectangle
        page.drawRectangle({
          x: rx,
          y: ry,
          width: rw,
          height: rh,
          color: rgb(1, 1, 1),
          borderWidth: 0,
        });
      }

      // Optional highlight behind replacement
      if (highlightHex) {
        const c = hexToRgb(highlightHex);
        const firstRegion = match.regions[0];
        const fontSize = Math.max(firstRegion.h * 0.85, 8);
        const highlightW = replaceText
          ? font.widthOfTextAtSize(replaceText, fontSize) + 8
          : coverMaxX - coverMinX;
        page.drawRectangle({
          x: coverMinX,
          y: coverMinY,
          width: highlightW,
          height: coverMaxY - coverMinY,
          color: rgb(c.r / 255, c.g / 255, c.b / 255),
          opacity: 0.3,
          borderWidth: 0,
        });
      }

      // Draw replacement text at the first region's position
      if (replaceText && match.regions.length > 0) {
        const firstRegion = match.regions[0];
        const fontSize = Math.max(firstRegion.h * 0.85, 8);
        page.drawText(replaceText, {
          x: firstRegion.x,
          y: firstRegion.y,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }

      replacements++;
    }

    const outBytes = await pdfDoc.save();
    const outBuffer = Buffer.from(outBytes);

    // Validate output actually changed
    validateOutputChanged(pdfBytes, outBuffer, "Find & Replace");

    // Save to output file and return download URL
    const outFilePath = outputPath(".pdf");
    await fs.writeFile(outFilePath, outBuffer);

    return res.json({
      success: true,
      downloadUrl: toDownloadUrl(req, outFilePath),
      filename: "find-replaced.pdf",
      replacements: replacements,
    });
  } catch (err) {
    next(err);
  }
});

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

module.exports = router;
