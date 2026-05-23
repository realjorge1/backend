const express = require("express");
const router = express.Router();
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fs = require("fs").promises;
const { extractTextWithPositions, buildLines } = require("../utils/pdfTextExtractor");
const { outputPath, toDownloadUrl } = require("../utils/fileOutputUtils");

// ── Patterns ────────────────────────────────────────────────────────────────

const REF_HEADINGS = [
  /^references?\s*$/i,
  /^bibliography\s*$/i,
  /^works?\s+cited\s*$/i,
  /^sources?\s*$/i,
  /^literature\s+cited\s*$/i,
  /^citations?\s*$/i,
  /^notes?\s+and\s+references?\s*$/i,
];

const AUTHOR_LAST_FIRST =
  /([A-Z][a-zA-Z'\-]+),\s+([A-Z][a-zA-Z]*\.?(?:\s+[A-Z]\.?)*)/g;
const YEAR_PATTERN = /\b(1[89]\d{2}|20[0-2]\d)\b/;
const DOI_PATTERN = /\b(10\.\d{4,}\/[^\s,;]+)/;
const URL_PATTERN = /https?:\/\/[^\s,;>)]+/;
const JOURNAL_VOL =
  /(\d+)\s*[\(\[]\s*(\d+)\s*[\)\]]\s*,?\s*(?:pp?\.\s*)?([\d\u2013\-]+)/;
const PAGES_PATTERN = /pp?\.\s*([\d\u2013\-]+)/i;
const VOL_PATTERN = /vol(?:ume)?\.?\s*(\d+)/i;
const ISSUE_PATTERN = /(?:no|issue|iss)\.?\s*(\d+)/i;

/**
 * POST /api/citations/extract
 * Body: multipart { pdf, style, includeInText? }
 */
router.post("/extract", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const style = (req.body.style || "apa").toLowerCase();
  const includeInText = req.body.includeInText !== "false";

  if (!["apa", "mla", "chicago"].includes(style)) {
    return res
      .status(400)
      .json({ error: "style must be one of: apa, mla, chicago" });
  }

  try {
    // Fast-fail for non-PDF uploads (e.g. ZIP-based formats like DOCX/EPUB)
    const fh = await fs.open(req.files.pdf.tempFilePath, "r");
    const headBuf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(headBuf, 0, 8192, 0);
    await fh.close();
    const head = headBuf.slice(0, bytesRead);
    const headHex = head.slice(0, 4).toString("hex");
    if (headHex === "504b0304" || headHex === "504b0506" || headHex === "504b0708") {
      return res.status(400).json({ error: "The uploaded file is not a PDF (it appears to be a ZIP-based format such as DOCX or EPUB). Please upload a valid PDF." });
    }
    if (head.slice(0, 5).toString("binary") !== "%PDF-" && head.toString("binary").indexOf("%PDF-") === -1) {
      return res.status(400).json({ error: "The uploaded file does not appear to be a valid PDF." });
    }

    const fullText = await extractFullText(
      req.files.pdf.tempFilePath,
    );
    const refSection = extractReferencesSection(fullText);
    const rawEntries = splitIntoEntries(refSection);
    const parsed = rawEntries
      .map(parseEntry)
      .filter((e) => e !== null);

    const inTextCitations = includeInText
      ? extractInTextCitations(fullText)
      : [];

    const formatted = parsed.map((entry) => ({
      ...entry,
      formatted: formatCitation(entry, style),
      raw: entry.raw,
    }));

    const pdfUrl = await buildCitationPDF(
      formatted,
      inTextCitations,
      style,
      req,
    );

    return res.json({
      style,
      total: formatted.length,
      citations: formatted,
      inTextCitations,
      pdfUrl,
      sectionFound: refSection.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/citations/format
 * Body: JSON { citations[], style }
 */
router.post("/format", express.json(), (req, res) => {
  const { citations, style } = req.body;
  if (!citations?.length) {
    return res
      .status(400)
      .json({ error: "citations array required" });
  }
  if (!["apa", "mla", "chicago"].includes(style)) {
    return res
      .status(400)
      .json({ error: "style must be apa, mla, or chicago" });
  }

  const formatted = citations.map((c) => ({
    ...c,
    formatted: formatCitation(c, style),
  }));

  return res.json({ style, citations: formatted });
});

// ── Text Extraction (using pdfjs-dist via shared extractor) ─────────────────

async function extractFullText(pdfPath) {
  const { pages } = await extractTextWithPositions(pdfPath);
  const pagesWithLines = buildLines(pages);

  const textParts = [];
  for (const page of pagesWithLines) {
    for (const line of page.lines) {
      textParts.push(line.text);
    }
    textParts.push("\n");
  }
  return textParts.join(" ");
}

// ── Reference Section Detection ─────────────────────────────────────────────

function extractReferencesSection(fullText) {
  const lines = fullText.split(/\n|\s{3,}/);
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (REF_HEADINGS.some((r) => r.test(line))) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*[\[\(]?1[\]\)]?\.?\s+[A-Z]/.test(lines[i])) {
        startIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1) return fullText;
  return lines.slice(startIdx).join("\n");
}

// ── Entry Splitting ─────────────────────────────────────────────────────────

function splitIntoEntries(text) {
  const numbered = text
    .split(/(?:^|\n)\s*[\[\(]?\d+[\]\)]?\.?\s+(?=[A-Z])/m)
    .map((e) => e.trim())
    .filter((e) => e.length > 20);

  if (numbered.length > 1) return numbered;

  return text
    .split(/\n{2,}|\n(?=[A-Z][a-z]+,?\s+[A-Z])/)
    .map((e) => e.replace(/\n/g, " ").trim())
    .filter((e) => e.length > 20 && YEAR_PATTERN.test(e));
}

// ── Entry Parser ────────────────────────────────────────────────────────────

function parseEntry(raw) {
  if (!raw || raw.length < 10) return null;

  const entry = {
    raw: raw.trim(),
    authors: [],
    year: "",
    title: "",
    journal: "",
    publisher: "",
    volume: "",
    issue: "",
    pages: "",
    doi: "",
    url: "",
    type: "unknown",
  };

  const yearMatch = raw.match(YEAR_PATTERN);
  if (yearMatch) entry.year = yearMatch[1];

  const doiMatch = raw.match(DOI_PATTERN);
  if (doiMatch) entry.doi = doiMatch[1];

  const urlMatch = raw.match(URL_PATTERN);
  if (urlMatch && !entry.doi) entry.url = urlMatch[0];

  const authorMatches = [...raw.matchAll(AUTHOR_LAST_FIRST)];
  if (authorMatches.length > 0) {
    entry.authors = authorMatches
      .slice(0, 6)
      .map((m) => ({ last: m[1], first: m[2] }));
  }

  const pagesMatch = raw.match(PAGES_PATTERN) || raw.match(JOURNAL_VOL);
  if (pagesMatch) entry.pages = pagesMatch[pagesMatch.length - 1];

  const volMatch = raw.match(VOL_PATTERN);
  const issueMatch = raw.match(ISSUE_PATTERN);
  if (volMatch) entry.volume = volMatch[1];
  if (issueMatch) entry.issue = issueMatch[1];

  const quotedTitle = raw.match(/["\u201c](.+?)["\u201d]/);
  if (quotedTitle) {
    entry.title = quotedTitle[1];
  } else {
    const afterYear = raw.replace(/.*?\d{4}[).]\s*/, "").trim();
    const titleEnd = afterYear.indexOf(". ");
    entry.title =
      titleEnd > 0
        ? afterYear.substring(0, titleEnd)
        : afterYear.substring(0, 120);
  }

  if (entry.volume || entry.pages) {
    entry.type = "journal";
    const afterTitle = raw.replace(entry.title, "").trim();
    const journalMatch = afterTitle.match(
      /\.\s+([A-Z][^.]+?)\s*,?\s*(?:vol|Vol|\d+[\(\[])/,
    );
    if (journalMatch) entry.journal = journalMatch[1].trim();
  } else if (/press|publish|edition|ed\./i.test(raw)) {
    entry.type = "book";
    const publisherMatch = raw.match(
      /([A-Z][^.]+?(?:Press|Publishers?|Publishing))/,
    );
    if (publisherMatch) entry.publisher = publisherMatch[1].trim();
  } else if (/https?:\/\//.test(raw)) {
    entry.type = "website";
  }

  return entry;
}

// ── In-Text Citations ───────────────────────────────────────────────────────

function extractInTextCitations(text) {
  const found = new Set();
  const pattern =
    /\(([A-Z][a-z]+(?:\s+et\s+al\.?)?(?:,?\s+&\s+[A-Z][a-z]+)*),?\s+(1[89]\d{2}|20[0-2]\d)(?:,\s*p+\.?\s*[\d\u2013\-]+)?\)/g;

  for (const match of text.matchAll(pattern)) {
    found.add(match[0]);
  }
  return [...found];
}

// ── Citation Formatters ─────────────────────────────────────────────────────

function formatAuthorsAPA(authors) {
  if (!authors.length) return "Unknown Author";
  return authors
    .map((a) => {
      const initials = a.first
        ? a.first
            .split(/\s+/)
            .map((n) => n[0] + ".")
            .join(" ")
        : "";
      return `${a.last}, ${initials}`;
    })
    .join(", ");
}

function formatAuthorsMLA(authors) {
  if (!authors.length) return "Unknown Author";
  const first = `${authors[0].last}, ${authors[0].first}`;
  if (authors.length === 1) return first;
  if (authors.length === 2)
    return `${first}, and ${authors[1].first} ${authors[1].last}`;
  return `${first}, et al.`;
}

function formatAuthorsChicago(authors) {
  if (!authors.length) return "Unknown Author";
  const first = `${authors[0].last}, ${authors[0].first}`;
  if (authors.length === 1) return first;
  const rest = authors
    .slice(1)
    .map((a) => `${a.first} ${a.last}`);
  if (authors.length > 3) return `${first} et al.`;
  return `${first}, ${rest.join(", ")}`;
}

function formatCitation(entry, style) {
  const {
    authors,
    year,
    title,
    journal,
    publisher,
    volume,
    issue,
    pages,
    doi,
    url,
    type,
  } = entry;
  const doiStr = doi
    ? ` https://doi.org/${doi}`
    : url
      ? ` ${url}`
      : "";
  const pagesStr = pages || "";

  switch (style) {
    case "apa": {
      const auth = formatAuthorsAPA(authors);
      const yr = year ? ` (${year}).` : ".";
      if (type === "journal") {
        const volIss = volume
          ? `, ${volume}${issue ? `(${issue})` : ""}`
          : "";
        const pp = pagesStr ? `, ${pagesStr}` : "";
        return `${auth}${yr} ${title ? title + "." : ""} *${journal || "Journal"}*${volIss}${pp}.${doiStr}`;
      }
      if (type === "book")
        return `${auth}${yr} *${title || "Untitled"}*. ${publisher || "Publisher"}.${doiStr}`;
      if (type === "website")
        return `${auth}${yr} ${title || "Untitled"}. Retrieved from ${url}`;
      return `${auth}${yr} ${title || entry.raw.substring(0, 100)}.${doiStr}`;
    }

    case "mla": {
      const auth = formatAuthorsMLA(authors);
      const yr = year || "n.d.";
      if (type === "journal") {
        const volIss = volume
          ? `, vol. ${volume}${issue ? `, no. ${issue}` : ""}`
          : "";
        const pp = pagesStr ? `, pp. ${pagesStr}` : "";
        return `${auth}. "${title || "Untitled"}." *${journal || "Journal"}*${volIss}, ${yr}${pp}.${doiStr}`;
      }
      if (type === "book")
        return `${auth}. *${title || "Untitled"}*. ${publisher || "Publisher"}, ${yr}.`;
      if (type === "website")
        return `${auth}. "${title || "Untitled"}." *Website*, ${yr}, ${url}.`;
      return `${auth}. "${title || entry.raw.substring(0, 100)}." ${yr}.`;
    }

    case "chicago": {
      const auth = formatAuthorsChicago(authors);
      const yr = year || "n.d.";
      if (type === "journal") {
        const volIss = volume
          ? ` ${volume}${issue ? `, no. ${issue}` : ""}`
          : "";
        const pp = pagesStr ? `: ${pagesStr}` : "";
        return `${auth}. ${yr}. "${title || "Untitled"}." *${journal || "Journal"}*${volIss}${pp}.${doiStr}`;
      }
      if (type === "book")
        return `${auth}. ${yr}. *${title || "Untitled"}*. ${publisher || "Publisher"}.`;
      if (type === "website")
        return `${auth}. ${yr}. "${title || "Untitled"}." ${url}.`;
      return `${auth}. ${yr}. "${title || entry.raw.substring(0, 100)}."`;
    }

    default:
      return entry.raw;
  }
}

// ── Build Output PDF ────────────────────────────────────────────────────────

async function buildCitationPDF(
  citations,
  inTextCitations,
  style,
  req,
) {
  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontObl = await doc.embedFont(
    StandardFonts.HelveticaOblique,
  );

  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 55;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }

  function ensureSpace(n) {
    if (y - n < MARGIN + 20) newPage();
  }

  function drawWrapped(
    text,
    x,
    maxWidth,
    fontSize,
    font,
    color = rgb(0, 0, 0),
  ) {
    const lh = fontSize + 4;
    const words = String(text).split(" ");
    const lines = [];
    let current = "";

    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (font.widthOfTextAtSize(test, fontSize) > maxWidth) {
        if (current) lines.push(current);
        current = w;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    lines.forEach((l) => {
      page.drawText(l, { x, y, size: fontSize, font, color });
      y -= lh;
    });
    return lines.length;
  }

  const styleLabels = {
    apa: "APA 7th Edition",
    mla: "MLA 9th Edition",
    chicago: "Chicago 17th Edition",
  };

  // Title
  page.drawText("Citation Export", {
    x: MARGIN,
    y,
    size: 20,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.5),
  });
  y -= 26;
  page.drawText(
    `Style: ${styleLabels[style]}   |   ${citations.length} reference${citations.length !== 1 ? "s" : ""}   |   ${new Date().toLocaleDateString()}`,
    {
      x: MARGIN,
      y,
      size: 10,
      font: fontObl,
      color: rgb(0.5, 0.5, 0.5),
    },
  );
  y -= 8;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.9),
  });
  y -= 22;

  page.drawText("References", {
    x: MARGIN,
    y,
    size: 13,
    font: fontBold,
    color: rgb(0.15, 0.15, 0.4),
  });
  y -= 18;

  if (citations.length === 0) {
    page.drawText(
      "No references were detected in this document.",
      {
        x: MARGIN,
        y,
        size: 11,
        font: fontObl,
        color: rgb(0.4, 0.4, 0.4),
      },
    );
  }

  citations.forEach((c, i) => {
    ensureSpace(50);
    page.drawText(`${i + 1}.`, {
      x: MARGIN,
      y,
      size: 10,
      font: fontBold,
      color: rgb(0.3, 0.3, 0.3),
    });
    drawWrapped(
      c.formatted || c.raw || "Unknown reference",
      MARGIN + 18,
      CONTENT_W - 18,
      10,
      fontReg,
      rgb(0.05, 0.05, 0.05),
    );
    y -= 4;

    const meta = [];
    if (c.type && c.type !== "unknown") meta.push(`Type: ${c.type}`);
    if (c.doi) meta.push(`DOI: ${c.doi}`);
    if (meta.length) {
      page.drawText(meta.join("  |  "), {
        x: MARGIN + 18,
        y,
        size: 8,
        font: fontObl,
        color: rgb(0.6, 0.6, 0.6),
      });
      y -= 12;
    }
    y -= 8;
  });

  if (inTextCitations.length > 0) {
    ensureSpace(40);
    y -= 10;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.8),
    });
    y -= 18;
    page.drawText(
      `In-Text Citations Found (${inTextCitations.length})`,
      {
        x: MARGIN,
        y,
        size: 12,
        font: fontBold,
        color: rgb(0.15, 0.15, 0.4),
      },
    );
    y -= 16;

    inTextCitations.forEach((cite) => {
      ensureSpace(16);
      page.drawText(`- ${cite}`, {
        x: MARGIN + 8,
        y,
        size: 10,
        font: fontReg,
        color: rgb(0.2, 0.2, 0.2),
      });
      y -= 14;
    });
  }

  // Page numbers
  const allPages = doc.getPages();
  allPages.forEach((pg, i) => {
    const { width } = pg.getSize();
    pg.drawText(`${i + 1} / ${allPages.length}`, {
      x: width / 2 - 15,
      y: 18,
      size: 8,
      font: fontReg,
      color: rgb(0.6, 0.6, 0.6),
    });
  });

  const bytes = await doc.save();
  const outPath = outputPath(".pdf");
  await fs.writeFile(outPath, bytes);
  return toDownloadUrl(req, outPath);
}

module.exports = router;
