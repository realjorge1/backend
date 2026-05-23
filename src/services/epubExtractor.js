/**
 * EPUB Text Extractor
 * Extracts text content from EPUB files chapter by chapter.
 * Uses the EPUB's internal HTML/XHTML files and strips tags.
 */

const fs = require("fs").promises;
const path = require("path");
const logger = require("../utils/logger");

// Lazy-load dependencies
let _AdmZip = null;

function getAdmZip() {
  if (!_AdmZip) {
    try {
      _AdmZip = require("adm-zip");
    } catch {
      // Fallback: use built-in EPUB parsing approach
      _AdmZip = null;
    }
  }
  return _AdmZip;
}

/**
 * Strip HTML/XML tags and decode common entities.
 */
function stripHtml(html) {
  if (!html) return "";
  let text = html
    // Remove script/style blocks
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    // Remove all tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/**
 * Parse the container.xml to find the OPF file path.
 */
function findOpfPath(containerXml) {
  const match = containerXml.match(/full-path\s*=\s*"([^"]+\.opf)"/i);
  return match ? match[1] : null;
}

/**
 * Parse the OPF file to get the reading order (spine).
 * Returns an array of { id, href } items in reading order.
 */
function parseOpf(opfContent, opfDir) {
  // Extract manifest items
  const manifest = new Map();
  const itemRegex =
    /<item\s[^>]*?id\s*=\s*"([^"]*)"[^>]*?href\s*=\s*"([^"]*)"[^>]*?>/gi;
  let match;
  while ((match = itemRegex.exec(opfContent)) !== null) {
    const id = match[1];
    const href = match[2];
    manifest.set(id, opfDir ? `${opfDir}/${href}` : href);
  }

  // Extract spine order
  const spineItems = [];
  const spineRegex = /<itemref\s[^>]*?idref\s*=\s*"([^"]*)"/gi;
  while ((match = spineRegex.exec(opfContent)) !== null) {
    const idref = match[1];
    const href = manifest.get(idref);
    if (href) {
      spineItems.push({ id: idref, href });
    }
  }

  return spineItems;
}

/**
 * Extract text from an EPUB buffer.
 * Returns { chapters: [{chapter, title, text}], meta: {totalChapters} }
 *
 * @param {Buffer} epubBuffer - Raw EPUB file buffer
 * @returns {Promise<{chapters: Array, meta: Object}>}
 */
async function extractEpubText(epubBuffer) {
  const AdmZip = getAdmZip();
  if (!AdmZip) {
    throw new Error(
      'EPUB support requires the "adm-zip" package. Run: npm install adm-zip',
    );
  }

  const zip = new AdmZip(epubBuffer);
  const entries = zip.getEntries();

  // Build a quick lookup: path → content
  const fileMap = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory) {
      fileMap.set(entry.entryName, entry);
    }
  }

  // 1. Find container.xml
  const containerEntry = fileMap.get("META-INF/container.xml");
  if (!containerEntry) {
    throw new Error("Invalid EPUB: missing META-INF/container.xml");
  }
  const containerXml = containerEntry.getData().toString("utf-8");

  // 2. Find OPF path
  const opfPath = findOpfPath(containerXml);
  if (!opfPath) {
    throw new Error("Invalid EPUB: could not locate OPF file");
  }

  const opfEntry = fileMap.get(opfPath);
  if (!opfEntry) {
    throw new Error(`Invalid EPUB: OPF file not found at ${opfPath}`);
  }
  const opfContent = opfEntry.getData().toString("utf-8");
  const opfDir = opfPath.includes("/")
    ? opfPath.substring(0, opfPath.lastIndexOf("/"))
    : "";

  // 3. Parse spine (reading order)
  const spineItems = parseOpf(opfContent, opfDir);

  if (spineItems.length === 0) {
    // Fallback: try to extract text from all HTML/XHTML files
    const htmlEntries = entries.filter(
      (e) =>
        !e.isDirectory &&
        (e.entryName.endsWith(".html") ||
          e.entryName.endsWith(".xhtml") ||
          e.entryName.endsWith(".htm")),
    );
    const chapters = htmlEntries.map((entry, idx) => {
      const html = entry.getData().toString("utf-8");
      const text = stripHtml(html);
      return {
        chapter: idx + 1,
        title: `Section ${idx + 1}`,
        text,
      };
    });

    return {
      chapters: chapters.filter((c) => c.text.length > 0),
      meta: { totalChapters: chapters.length },
    };
  }

  // 4. Extract text from each spine item
  const chapters = [];
  for (let i = 0; i < spineItems.length; i++) {
    const item = spineItems[i];
    // Normalize the href (remove query strings, decode URI)
    const href = decodeURIComponent(item.href.split("#")[0]);
    const entry = fileMap.get(href);

    if (!entry) continue;

    const html = entry.getData().toString("utf-8");
    const text = stripHtml(html);

    if (text.length < 5) continue; // Skip empty chapters

    // Try to extract chapter title from first heading
    const titleMatch = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const title = titleMatch
      ? stripHtml(titleMatch[1]).slice(0, 100)
      : `Chapter ${chapters.length + 1}`;

    chapters.push({
      chapter: chapters.length + 1,
      title,
      text,
    });
  }

  return {
    chapters,
    meta: {
      totalChapters: chapters.length,
    },
  };
}

/**
 * Convert EPUB chapters into page-like structures for the RAG pipeline.
 * Each chapter is treated as a "page" for compatibility with the existing chunking system.
 */
function chaptersToPages(chapters) {
  return chapters.map((ch) => ({
    page: ch.chapter,
    text: ch.text,
    wasOcr: false,
    charCount: ch.text.length,
    chapterTitle: ch.title,
  }));
}

module.exports = { extractEpubText, chaptersToPages };
