/**
 * Text Cleaning & Chunking Utilities
 * - Cleans raw extracted text (fix hyphenation, remove headers/footers)
 * - Splits into chunks for LLM context with page anchors
 */

const MAX_CHUNK_TOKENS = 1200; // ~1200 tokens ≈ ~900 words
const AVG_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * AVG_CHARS_PER_TOKEN;

/**
 * Clean raw extracted text from a single page.
 */
function cleanPageText(rawText) {
  let text = rawText;

  // 1. Fix hyphenated line breaks: "exam-\nple" → "example"
  text = text.replace(/(\w)-\n(\w)/g, "$1$2");

  // 2. Collapse multiple blank lines into one
  text = text.replace(/\n{3,}/g, "\n\n");

  // 3. Remove lines that are ONLY page numbers
  text = text.replace(/^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/gm, "");

  // 4. Normalize whitespace within lines
  text = text
    .split("\n")
    .map((line) => line.replace(/\s{2,}/g, " ").trim())
    .join("\n");

  return text.trim();
}

/**
 * Detect and remove repeated header/footer lines across all pages.
 * A line appearing on >40% of pages is considered a header/footer.
 *
 * @param {Array<{page: number, text: string}>} pages
 * @returns {Array<{page: number, text: string}>}
 */
function removeRepeatedHeadersFooters(pages) {
  const totalPages = pages.length;

  // Header/footer detection is only meaningful when there are enough pages for
  // "repetition" to carry signal. On short documents every line appears on
  // 100% of pages by construction — applying the 40% threshold would wipe the
  // entire document. Skip cleanup in that regime.
  if (totalPages < 3) return pages;

  const lineCounts = new Map();
  for (const { text } of pages) {
    const lines = text.split("\n");
    const uniqueLines = new Set(
      lines.map((l) => l.trim()).filter((l) => l.length > 3),
    );
    for (const line of uniqueLines) {
      lineCounts.set(line, (lineCounts.get(line) || 0) + 1);
    }
  }

  // A line must appear on at least 60% of pages AND on at least 3 pages.
  // Using 0.4 / min-2 was too aggressive: any line on 2 of 5 pages got wiped,
  // which destroyed real content in 3–10 page documents.
  const threshold = Math.max(3, Math.ceil(totalPages * 0.6));
  const repeatedLines = new Set(
    [...lineCounts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([line]) => line),
  );

  if (repeatedLines.size === 0) return pages;

  return pages.map(({ page, text, wasOcr, charCount }) => {
    const cleaned = text
      .split("\n")
      .filter((line) => !repeatedLines.has(line.trim()))
      .join("\n");
    return { page, text: cleaned, wasOcr, charCount };
  });
}

/**
 * Full pipeline: clean all pages.
 *
 * @param {Array<{page: number, text: string, wasOcr: boolean, charCount: number}>} pages
 * @returns {Array<{page: number, text: string, wasOcr: boolean, charCount: number}>}
 */
function cleanAllPages(pages) {
  const cleaned = pages.map((p) => ({
    ...p,
    text: cleanPageText(p.text),
  }));

  return removeRepeatedHeadersFooters(cleaned);
}

/**
 * Chunk cleaned pages into LLM-ready segments.
 * Preserves "Page N:" markers for citation.
 *
 * @param {Array<{page: number, text: string}>} pages
 * @returns {Array<{chunkId: number, text: string, pages: number[]}>}
 */
function chunkPages(pages) {
  const chunks = [];
  let currentChunk = "";
  let currentPages = [];
  let chunkId = 0;

  for (const { page, text } of pages) {
    if (!text || text.trim().length === 0) continue;

    const pageBlock = `[Page ${page}]\n${text}`;

    // If adding this page would exceed limit, flush current chunk first
    if (
      currentChunk.length + pageBlock.length > MAX_CHUNK_CHARS &&
      currentChunk.length > 0
    ) {
      chunks.push({
        chunkId: chunkId++,
        text: currentChunk.trim(),
        pages: [...currentPages],
      });
      currentChunk = "";
      currentPages = [];
    }

    // Handle very long single pages (split by paragraphs)
    if (pageBlock.length > MAX_CHUNK_CHARS) {
      const subChunks = splitLargePage(page, text, MAX_CHUNK_CHARS);
      for (const sub of subChunks) {
        chunks.push({
          chunkId: chunkId++,
          text: sub,
          pages: [page],
        });
      }
      continue;
    }

    currentChunk += (currentChunk ? "\n\n" : "") + pageBlock;
    currentPages.push(page);
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 0) {
    chunks.push({
      chunkId: chunkId++,
      text: currentChunk.trim(),
      pages: [...currentPages],
    });
  }

  return chunks;
}

/**
 * Split a single very long page into multiple sub-chunks at paragraph boundaries.
 */
function splitLargePage(pageNum, text, maxChars) {
  const paragraphs = text.split(/\n{2,}/);
  const subChunks = [];
  let current = `[Page ${pageNum}]\n`;

  for (const para of paragraphs) {
    if (current.length + para.length > maxChars && current.length > 20) {
      subChunks.push(current.trim());
      current = `[Page ${pageNum} continued]\n`;
    }
    current += para + "\n\n";
  }

  if (current.trim().length > 0) subChunks.push(current.trim());
  return subChunks;
}

module.exports = { cleanAllPages, chunkPages };
