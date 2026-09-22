/**
 * Per-format text extraction.
 *
 * Every extractor returns the same shape:
 *   { units: [{ index, label, text, wasOcr? }], meta, fileType, locatorType }
 *
 * A "unit" is the smallest citable piece of the document: a PDF page, a
 * slide, a worksheet, an EPUB chapter, or a section of a flat document.
 */

const path = require("path");
const logger = require("../utils/logger");
const apiConfig = require("../config/apiConfig");
const { extractPdfText } = require("./pdfExtractor");
const { cleanAllPages } = require("./textCleaner");
const { labelFor } = require("./locators");

/** Split flat text into sections at blank-line boundaries. */
function splitIntoSections(text, maxChars = apiConfig.extraction.sectionChars) {
  const sections = [];
  const paragraphs = String(text || "").split(/\n{2,}/);
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      sections.push(current.trim());
      current = "";
    }
    // A single paragraph longer than the budget becomes its own section.
    if (paragraph.length > maxChars) {
      if (current.trim()) sections.push(current.trim());
      current = "";
      for (let i = 0; i < paragraph.length; i += maxChars) {
        sections.push(paragraph.slice(i, i + maxChars).trim());
      }
      continue;
    }
    current += (current ? "\n\n" : "") + paragraph;
  }
  if (current.trim()) sections.push(current.trim());
  return sections.filter((s) => s.length > 0);
}

function unitsFromSections(sections, locatorType = "section") {
  return sections.map((text, i) => ({
    index: i + 1,
    label: labelFor(locatorType, i + 1),
    text,
  }));
}

function baseMeta(filename, fileType, units, extra = {}) {
  return {
    totalPages: units.length,
    scannedPages: 0,
    hasScannedContent: false,
    filename,
    fileType,
    extractedAt: new Date().toISOString(),
    ...extra,
  };
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

async function extractPdf(buffer, filename) {
  const result = await extractPdfText(buffer);
  const pages = cleanAllPages(result.pages);

  const units = pages.map((p, i) => ({
    index: typeof p.page === "number" ? p.page : i + 1,
    label: labelFor("page", typeof p.page === "number" ? p.page : i + 1),
    text: p.text || "",
    wasOcr: Boolean(p.wasOcr),
  }));

  return {
    units,
    fileType: "pdf",
    locatorType: "page",
    meta: {
      ...result.meta,
      filename,
      fileType: "pdf",
      extractedAt: new Date().toISOString(),
    },
  };
}

// ─── DOCX ────────────────────────────────────────────────────────────────────

async function extractDocx(buffer, filename) {
  const mammoth = require("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  const sections = splitIntoSections(result.value || "");
  const units = unitsFromSections(sections.length > 0 ? sections : [""]);

  return {
    units,
    fileType: "docx",
    locatorType: "section",
    meta: baseMeta(filename, "docx", units),
  };
}

// ─── EPUB ────────────────────────────────────────────────────────────────────

async function extractEpub(buffer, filename) {
  const { extractEpubText, chaptersToPages } = require("./epubExtractor");
  const { chapters } = await extractEpubText(buffer);
  const pages = cleanAllPages(chaptersToPages(chapters));

  const units = pages.map((p, i) => ({
    index: p.page ?? i + 1,
    label: labelFor("chapter", p.page ?? i + 1, p.chapterTitle),
    text: p.text || "",
  }));

  return {
    units,
    fileType: "epub",
    locatorType: "chapter",
    meta: baseMeta(filename, "epub", units),
  };
}

// ─── PPTX ────────────────────────────────────────────────────────────────────

async function extractPptx(buffer, filename) {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip(buffer);
  const slideEntries = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName));

  const slideTexts = slideEntries.map((entry, idx) => {
    const xml = entry.getData().toString("utf8");
    const texts = [];
    const rx = /<a:t[^>]*>([^<]+)<\/a:t>/g;
    let m;
    while ((m = rx.exec(xml)) !== null) {
      const t = m[1].trim();
      if (t) texts.push(t);
    }
    return `[Slide ${idx + 1}]\n${texts.join(" ")}`;
  });

  const sections = splitIntoSections(slideTexts.filter((s) => s.trim()).join("\n\n"));
  const units = unitsFromSections(
    sections.length > 0 ? sections : ["(No text found in slides)"],
  );

  return {
    units,
    fileType: "pptx",
    locatorType: "section",
    meta: baseMeta(filename, "pptx", units),
  };
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

async function extractXlsx(buffer, filename) {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip(buffer);

  const ssEntry = zip.getEntry("xl/sharedStrings.xml");
  const strings = [];
  if (ssEntry) {
    const xml = ssEntry.getData().toString("utf8");
    const rx = /<t[^>]*>([^<]*)<\/t>/g;
    let m;
    while ((m = rx.exec(xml)) !== null) {
      if (m[1].trim()) strings.push(m[1]);
    }
  }

  const sheetEntries = zip
    .getEntries()
    .filter((e) => /^xl\/worksheets\/sheet\d*\.xml$/.test(e.entryName));
  const inlineTexts = [];
  for (const entry of sheetEntries) {
    const xml = entry.getData().toString("utf8");
    const rx = /<is>[\s\S]*?<t[^>]*>([^<]+)<\/t>[\s\S]*?<\/is>/g;
    let m;
    while ((m = rx.exec(xml)) !== null) {
      if (m[1].trim()) inlineTexts.push(m[1]);
    }
  }

  const sections = splitIntoSections([...strings, ...inlineTexts].join(" "));
  const units = unitsFromSections(
    sections.length > 0 ? sections : ["(No text content found in spreadsheet)"],
  );

  return {
    units,
    fileType: "xlsx",
    locatorType: "section",
    meta: baseMeta(filename, "xlsx", units),
  };
}

// ─── Plain text ──────────────────────────────────────────────────────────────

async function extractPlainText(buffer, filename, fileType) {
  const sections = splitIntoSections(buffer.toString("utf-8"));
  const units = unitsFromSections(sections.length > 0 ? sections : [""]);

  return {
    units,
    fileType,
    locatorType: "section",
    meta: baseMeta(filename, fileType, units),
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

class UnsupportedFileTypeError extends Error {
  constructor(descriptor) {
    super(`Unsupported file type: ${descriptor}`);
    this.code = "UNSUPPORTED_FILE_TYPE";
  }
}

/**
 * @param {{buffer: Buffer, filename: string, ext?: string, mimeType?: string}} input
 */
async function extractUnits({ buffer, filename, ext, mimeType }) {
  const extension = (ext || path.extname(filename || "")).toLowerCase();
  const mime = (mimeType || "").toLowerCase();

  let result;
  if (extension === ".pdf" || mime === "application/pdf") {
    result = await extractPdf(buffer, filename);
  } else if (extension === ".docx" || mime === DOCX_MIME) {
    result = await extractDocx(buffer, filename);
  } else if (extension === ".epub" || mime === "application/epub+zip") {
    result = await extractEpub(buffer, filename);
  } else if (extension === ".pptx" || mime === PPTX_MIME) {
    result = await extractPptx(buffer, filename);
  } else if (extension === ".xlsx" || mime === XLSX_MIME) {
    result = await extractXlsx(buffer, filename);
  } else if (mime.startsWith("text/") || [".txt", ".md", ".csv"].includes(extension)) {
    result = await extractPlainText(buffer, filename, extension.replace(".", "") || "txt");
  } else {
    throw new UnsupportedFileTypeError(extension || mime || "unknown");
  }

  // Never store a document with no units at all — downstream code assumes at
  // least one citable location exists.
  if (!result.units || result.units.length === 0) {
    result.units = [{ index: 1, label: labelFor(result.locatorType, 1), text: "" }];
    result.meta.totalPages = 1;
  }

  logger.info(
    `[extract] ${filename}: ${result.units.length} ${result.locatorType}(s), ` +
      `${result.units.reduce((n, u) => n + u.text.length, 0)} chars`,
  );

  return result;
}

module.exports = {
  extractUnits,
  splitIntoSections,
  unitsFromSections,
  UnsupportedFileTypeError,
};
