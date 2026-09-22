// ============================================
// FILE: services/locators.js
// How a document's units are named. A "locator" is the citable position of a
// piece of text: a page in a PDF, a slide in a deck, a sheet in a workbook,
// a chapter in an EPUB, a section everywhere else.
// ============================================

const LOCATOR_TYPES = ["page", "slide", "sheet", "chapter", "section"];

const BY_FILE_TYPE = {
  pdf: "page",
  pptx: "slide",
  ppt: "slide",
  xlsx: "sheet",
  xls: "sheet",
  epub: "chapter",
  docx: "section",
  doc: "section",
  txt: "section",
  md: "section",
  csv: "section",
};

/** @returns {"page"|"slide"|"sheet"|"chapter"|"section"} */
function locatorTypeFor(fileType) {
  const key = String(fileType || "").toLowerCase().replace(/^\./, "");
  return BY_FILE_TYPE[key] || "section";
}

/**
 * Human-readable label for one unit.
 * @param {string} locatorType
 * @param {number} index      1-based
 * @param {string} [name]     sheet name, chapter title, section heading
 */
function labelFor(locatorType, index, name) {
  const trimmed = name ? String(name).trim() : "";
  switch (locatorType) {
    case "slide":
      return `Slide ${index}`;
    case "sheet":
      return trimmed ? `Sheet "${trimmed}"` : `Sheet ${index}`;
    case "chapter":
      return trimmed ? `Chapter ${index} · ${trimmed}` : `Chapter ${index}`;
    case "section":
      return trimmed ? `Section ${index} · ${trimmed}` : `Section ${index}`;
    case "page":
    default:
      return `Page ${index}`;
  }
}

/**
 * The anchor written into chunk text so the model can attribute a passage.
 * Kept in the "[Page 3]" shape the existing prompts and parsers already use.
 */
function anchorFor(locatorType, index, name) {
  return `[${labelFor(locatorType, index, name)}]`;
}

module.exports = { LOCATOR_TYPES, locatorTypeFor, labelFor, anchorFor };
