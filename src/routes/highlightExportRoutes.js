const express = require("express");
const router = express.Router();
const {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFString,
  StandardFonts,
  rgb,
} = require("pdf-lib");
const fs = require("fs").promises;
const { outputPath, toDownloadUrl } = require("../utils/fileOutputUtils");
const { safeLoadPDF } = require("../services/pdfService");

const ANNOTATION_TYPES = new Set([
  "Highlight",
  "Underline",
  "StrikeOut",
  "FreeText",
  "Text",
  "Square",
]);

const COLOR_NAMES = {
  yellow: { r: [0.9, 1.1], g: [0.9, 1.1], b: [-0.1, 0.2] },
  green: { r: [-0.1, 0.3], g: [0.6, 1.1], b: [-0.1, 0.4] },
  blue: { r: [-0.1, 0.4], g: [0.4, 1.1], b: [0.6, 1.1] },
  pink: { r: [0.8, 1.1], g: [0.4, 0.8], b: [0.6, 1.1] },
  red: { r: [0.7, 1.1], g: [-0.1, 0.3], b: [-0.1, 0.3] },
  orange: { r: [0.8, 1.1], g: [0.4, 0.7], b: [-0.1, 0.2] },
};

function guessColorName(c) {
  if (!c || c.length < 3) return "unknown";
  const [r, g, b] = c;
  for (const [name, range] of Object.entries(COLOR_NAMES)) {
    if (
      r >= range.r[0] &&
      r <= range.r[1] &&
      g >= range.g[0] &&
      g <= range.g[1] &&
      b >= range.b[0] &&
      b <= range.b[1]
    )
      return name;
  }
  return "custom";
}

/**
 * POST /api/highlight-export
 * Body: multipart { pdf, groupBy?, includeNotes?, includeColors? }
 * Returns: { url, total, pages, groups, breakdown }
 */
router.post("/", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const groupBy = req.body.groupBy || "page";
  const includeNotes = req.body.includeNotes !== "false";
  const includeColors = req.body.includeColors !== "false";

  try {
    const pdfBytes = await fs.readFile(req.files.pdf.tempFilePath);
    const pdfDoc = await safeLoadPDF(pdfBytes, {
      ignoreEncryption: true,
    });
    const pages = pdfDoc.getPages();
    const docTitle = pdfDoc.getTitle() || "Untitled Document";

    const annotations = [];

    for (let pi = 0; pi < pages.length; pi++) {
      const pageNode = pages[pi].node;
      const annotsRef = pageNode.lookupMaybe(
        PDFName.of("Annots"),
        PDFArray,
      );
      if (!annotsRef) continue;

      for (let ai = 0; ai < annotsRef.size(); ai++) {
        try {
          const annotRef = annotsRef.lookup(ai);
          if (!(annotRef instanceof PDFDict)) continue;

          const subtype = annotRef.lookupMaybe(
            PDFName.of("Subtype"),
            PDFName,
          );
          if (!subtype) continue;

          const subtypeName = subtype.asString().replace("/", "");
          if (!ANNOTATION_TYPES.has(subtypeName)) continue;

          const contentsObj = annotRef.lookupMaybe(
            PDFName.of("Contents"),
          );
          const authorObj = annotRef.lookupMaybe(PDFName.of("T"));
          const dateObj = annotRef.lookupMaybe(PDFName.of("M"));
          const colorObj = annotRef.lookupMaybe(
            PDFName.of("C"),
            PDFArray,
          );
          const rcObj = annotRef.lookupMaybe(PDFName.of("RC"));

          let text = "";
          if (contentsObj) {
            text =
              contentsObj instanceof PDFString
                ? contentsObj.decodeText()
                : contentsObj.toString().replace(/[()]/g, "");
          }

          let highlightedText = text;
          if (rcObj) {
            const rc =
              rcObj instanceof PDFString
                ? rcObj.decodeText()
                : rcObj.toString();
            highlightedText =
              rc.replace(/<[^>]+>/g, "").trim() || text;
          }

          let color = [];
          if (colorObj) {
            for (let ci = 0; ci < colorObj.size(); ci++) {
              const v = colorObj.lookup(ci);
              color.push(v?.asNumber?.() ?? 0);
            }
          }

          const author = authorObj
            ? authorObj instanceof PDFString
              ? authorObj.decodeText()
              : authorObj.toString().replace(/[()]/g, "")
            : "Unknown";

          const dateStr = dateObj
            ? dateObj instanceof PDFString
              ? dateObj.decodeText()
              : dateObj.toString().replace(/[()D:Z']/g, "")
            : null;

          annotations.push({
            page: pi + 1,
            type: subtypeName,
            text:
              highlightedText || `[${subtypeName} annotation]`,
            note:
              subtypeName === "Text" || subtypeName === "FreeText"
                ? text
                : "",
            author,
            color,
            colorName: guessColorName(color),
            date: dateStr,
          });
        } catch {
          // Skip malformed annotations
        }
      }
    }

    // Group annotations
    const groups = groupAnnotations(annotations, groupBy);

    // Build PDF summary
    const summaryDoc = await PDFDocument.create();
    const fontReg = await summaryDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await summaryDoc.embedFont(
      StandardFonts.HelveticaBold,
    );
    const fontObliq = await summaryDoc.embedFont(
      StandardFonts.HelveticaOblique,
    );

    const PAGE_W = 595;
    const PAGE_H = 842;
    const MARGIN = 50;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    let currentPage = summaryDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;

    function ensureSpace(needed) {
      if (y - needed < MARGIN) {
        currentPage = summaryDoc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
    }

    function drawWrapped(
      text,
      x,
      startY,
      maxWidth,
      fontSize,
      font,
      color = rgb(0, 0, 0),
    ) {
      const words = String(text).split(" ");
      const lines = [];
      let line = "";

      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(test, fontSize) > maxWidth) {
          if (line) lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);

      let drawY = startY;
      for (const l of lines) {
        currentPage.drawText(l, {
          x,
          y: drawY,
          size: fontSize,
          font,
          color,
        });
        drawY -= fontSize + 3;
      }
      return lines.length;
    }

    // Cover page
    currentPage.drawText("Highlight Export", {
      x: MARGIN,
      y,
      size: 22,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.5),
    });
    y -= 30;

    currentPage.drawText(docTitle, {
      x: MARGIN,
      y,
      size: 14,
      font: fontBold,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= 20;

    currentPage.drawText(
      `Exported: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}   |   ${annotations.length} annotation${annotations.length !== 1 ? "s" : ""}   |   ${pages.length} pages`,
      {
        x: MARGIN,
        y,
        size: 10,
        font: fontReg,
        color: rgb(0.5, 0.5, 0.5),
      },
    );
    y -= 8;

    currentPage.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 1,
      color: rgb(0.7, 0.7, 0.9),
    });
    y -= 25;

    if (annotations.length === 0) {
      currentPage.drawText(
        "No annotations found in this document.",
        {
          x: MARGIN,
          y,
          size: 12,
          font: fontObliq,
          color: rgb(0.4, 0.4, 0.4),
        },
      );
    }

    // Render groups
    for (const group of groups) {
      ensureSpace(40);

      currentPage.drawRectangle({
        x: MARGIN,
        y: y - 4,
        width: CONTENT_W,
        height: 20,
        color: rgb(0.92, 0.92, 0.98),
      });
      currentPage.drawText(group.label, {
        x: MARGIN + 6,
        y,
        size: 11,
        font: fontBold,
        color: rgb(0.15, 0.15, 0.4),
      });
      y -= 28;

      for (const ann of group.items) {
        ensureSpace(60);

        const typeLabel =
          ann.type === "Highlight"
            ? "Highlight"
            : ann.type === "Underline"
              ? "Underline"
              : ann.type === "StrikeOut"
                ? "StrikeOut"
                : ann.type === "FreeText"
                  ? "FreeText"
                  : ann.type === "Text"
                    ? "Note"
                    : ann.type;

        if (ann.color.length >= 3 && includeColors) {
          currentPage.drawRectangle({
            x: MARGIN,
            y: y - 12,
            width: 4,
            height: 16,
            color: rgb(
              Math.min(ann.color[0], 1),
              Math.min(ann.color[1], 1),
              Math.min(ann.color[2], 1),
            ),
          });
        }

        const textX = MARGIN + (includeColors ? 10 : 0);

        currentPage.drawText(
          `${typeLabel}  |  Page ${ann.page}${includeColors && ann.colorName !== "unknown" ? `  |  ${ann.colorName}` : ""}${ann.author !== "Unknown" ? `  |  ${ann.author}` : ""}`,
          {
            x: textX,
            y,
            size: 9,
            font: fontObliq,
            color: rgb(0.4, 0.4, 0.4),
          },
        );
        y -= 14;

        if (
          ann.text &&
          ann.text !== `[${ann.type} annotation]`
        ) {
          ensureSpace(30);
          const linesDrawn = drawWrapped(
            `"${ann.text}"`,
            textX + 4,
            y,
            CONTENT_W - 14,
            10,
            fontReg,
            rgb(0.1, 0.1, 0.1),
          );
          y -= linesDrawn * 13 + 4;
        }

        if (includeNotes && ann.note) {
          ensureSpace(20);
          currentPage.drawText("Note:", {
            x: textX + 4,
            y,
            size: 9,
            font: fontBold,
            color: rgb(0.3, 0.3, 0.6),
          });
          y -= 12;
          const noteLines = drawWrapped(
            ann.note,
            textX + 12,
            y,
            CONTENT_W - 22,
            9,
            fontObliq,
            rgb(0.3, 0.3, 0.6),
          );
          y -= noteLines * 12 + 4;
        }

        currentPage.drawLine({
          start: { x: textX, y: y + 2 },
          end: { x: PAGE_W - MARGIN, y: y + 2 },
          thickness: 0.3,
          color: rgb(0.85, 0.85, 0.85),
        });
        y -= 10;
      }

      y -= 10;
    }

    // Page numbers
    const summaryPages = summaryDoc.getPages();
    for (let i = 0; i < summaryPages.length; i++) {
      const pg = summaryPages[i];
      const { width } = pg.getSize();
      pg.drawText(`Page ${i + 1} of ${summaryPages.length}`, {
        x: width / 2 - 30,
        y: 20,
        size: 8,
        font: fontReg,
        color: rgb(0.6, 0.6, 0.6),
      });
    }

    const outBytes = await summaryDoc.save();
    const outPath = outputPath(".pdf");
    await fs.writeFile(outPath, outBytes);

    return res.json({
      url: toDownloadUrl(req, outPath),
      total: annotations.length,
      pages: pages.length,
      groups: groups.length,
      breakdown: getBreakdown(annotations),
    });
  } catch (err) {
    next(err);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function groupAnnotations(annotations, groupBy) {
  const map = new Map();

  for (const ann of annotations) {
    let key;
    if (groupBy === "color") key = ann.colorName || "Unknown Color";
    else if (groupBy === "author")
      key = ann.author || "Unknown Author";
    else key = `Page ${ann.page}`;

    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ann);
  }

  const entries = [...map.entries()];
  if (groupBy === "page") {
    entries.sort(
      (a, b) =>
        parseInt(a[0].replace("Page ", "")) -
        parseInt(b[0].replace("Page ", "")),
    );
  } else {
    entries.sort((a, b) => a[0].localeCompare(b[0]));
  }

  return entries.map(([label, items]) => ({ label, items }));
}

function getBreakdown(annotations) {
  const counts = {};
  for (const ann of annotations) {
    counts[ann.type] = (counts[ann.type] || 0) + 1;
  }
  return counts;
}

module.exports = router;
