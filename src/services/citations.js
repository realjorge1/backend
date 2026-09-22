/**
 * Citations
 *
 * A citation is only worth showing if its quote is really in the document.
 * Everything a model claims to have quoted is checked here against the stored
 * text; anything that fails is dropped and its marker removed from the answer,
 * so a user never sees a source that doesn't exist.
 *
 * Matching ignores differences that carry no meaning — whitespace, curly vs
 * straight quotes, dash variants, soft hyphens, words hyphenated across a
 * line break, and letter case — but nothing else. A paraphrase does not pass.
 */

const { labelFor } = require("./locators");

const MAX_QUOTE_CHARS = 300;

/**
 * Reduce text to the form used for comparison. Only cosmetic differences are
 * erased: the words themselves must still match.
 */
function normalizeForMatch(text) {
  return String(text || "")
    .normalize("NFKC")
    // Words split across a line break: "exam-\nple" is the word "example".
    .replace(/-[\r\n]+\s*/g, "")
    .replace(/­/g, "") // soft hyphen
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Trim to at most 300 characters, ending on a word boundary. */
function trimQuote(quote) {
  const text = String(quote || "").trim();
  if (text.length <= MAX_QUOTE_CHARS) return text;

  const cut = text.slice(0, MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_QUOTE_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Which unit a quote came from: prefer a unit of the citing chunk that really
 * contains it, then any unit of the document, then the chunk's first unit.
 */
function locateQuote(normalizedQuote, chunk, doc) {
  const units = Array.isArray(doc?.units) ? doc.units : [];
  const chunkUnitIndexes = chunk?.unitIndexes || chunk?.pages || [];

  const candidates = [
    ...units.filter((u) => chunkUnitIndexes.includes(u.index)),
    ...units.filter((u) => !chunkUnitIndexes.includes(u.index)),
  ];

  for (const unit of candidates) {
    if (normalizeForMatch(unit.text).includes(normalizedQuote)) return unit;
  }
  return units.find((u) => u.index === chunkUnitIndexes[0]) || null;
}

/**
 * Verify a model's citations against the document, then renumber the answer's
 * markers to match what survived.
 *
 * @param {object} params
 *   answer    — the model's answer, containing [n] markers
 *   citations — [{ id, chunk, quote }] as produced by the model
 *   doc       — the stored document (units, locatorType)
 *   chunks    — the chunks that were shown to the model
 * @returns {{answer: string, citations: Array, dropped: number}}
 */
function verifyCitations({ answer, citations, doc, chunks }) {
  const text = String(answer || "");
  const source = Array.isArray(citations) ? citations : [];
  const shown = Array.isArray(chunks) ? chunks : [];
  const locatorType = doc?.locatorType || "page";

  const chunkById = new Map(shown.map((c) => [c.chunkId, c]));
  const documentText = normalizeForMatch(
    (doc?.units || []).map((u) => u.text).join("\n"),
  );

  // 1. Keep only citations whose quote is really in the document.
  const verified = [];
  let dropped = 0;

  for (const citation of source) {
    const quote = trimQuote(citation?.quote);
    if (!quote) {
      dropped++;
      continue;
    }

    const normalizedQuote = normalizeForMatch(quote);
    if (!normalizedQuote) {
      dropped++;
      continue;
    }

    const chunk = chunkById.get(citation.chunk ?? citation.chunkId);
    const inChunk = chunk
      ? normalizeForMatch(chunk.text).includes(normalizedQuote)
      : false;
    const inDocument = inChunk || documentText.includes(normalizedQuote);

    if (!inDocument) {
      dropped++;
      continue;
    }

    const unit = locateQuote(normalizedQuote, chunk, doc);
    const index = unit?.index ?? (chunk?.unitIndexes || chunk?.pages || [])[0] ?? 1;

    verified.push({
      originalId: Number(citation.id),
      page: index,
      locator: {
        type: locatorType,
        index,
        label: unit?.label || labelFor(locatorType, index),
      },
      quote,
      chunkId: chunk?.chunkId ?? citation.chunk ?? null,
    });
  }

  // 2. Renumber 1..n in order of first appearance in the answer.
  const appearance = [];
  for (const match of text.matchAll(/\[(\d+)\]/g)) {
    const id = Number(match[1]);
    if (!appearance.includes(id)) appearance.push(id);
  }

  const survivingIds = new Set(verified.map((c) => c.originalId));
  const ordered = [
    ...appearance.filter((id) => survivingIds.has(id)),
    ...verified.map((c) => c.originalId).filter((id) => !appearance.includes(id)),
  ];

  const renumbered = new Map();
  ordered.forEach((oldId, i) => renumbered.set(oldId, i + 1));

  const finalCitations = verified
    .filter((c) => renumbered.has(c.originalId))
    .map((c) => ({
      id: renumbered.get(c.originalId),
      page: c.page,
      locator: c.locator,
      quote: c.quote,
      chunkId: c.chunkId,
    }))
    .sort((a, b) => a.id - b.id);

  // 3. Rewrite the markers: survivors get their new number, the rest go away.
  const rewritten = rewriteMarkers(text, renumbered);

  return { answer: rewritten, citations: finalCitations, dropped };
}

/**
 * Replace [oldId] with [newId] and delete markers with no citation left,
 * tidying the punctuation and spacing a removal leaves behind.
 */
function rewriteMarkers(text, renumbered) {
  const replaced = text.replace(/\[(\d+)\]/g, (match, digits) => {
    const newId = renumbered.get(Number(digits));
    return newId ? `[${newId}]` : "";
  });

  return replaced
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+$/gm, "");
}

/**
 * Pull the trailing <citations>{...}</citations> block out of a reply.
 *
 * @returns {{answer: string, citations: Array, found: boolean|null}}
 */
function extractCitationBlock(raw) {
  const text = String(raw || "");
  const match = text.match(/<citations>\s*([\s\S]*?)\s*<\/citations>/i);

  if (!match) {
    // The block may still be arriving (streaming) or the model may have
    // skipped it. Strip any partial opening tag so it never reaches the user.
    return {
      answer: text.replace(/<citations>[\s\S]*$/i, "").trim(),
      citations: [],
      found: null,
    };
  }

  const answer = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .trim();

  try {
    const parsed = JSON.parse(match[1]);
    return {
      answer,
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      found: typeof parsed.found === "boolean" ? parsed.found : null,
    };
  } catch {
    // A malformed block is not worth failing the answer over.
    return { answer, citations: [], found: null };
  }
}

/**
 * Render retrieved chunks for the model, tagged with the location each one
 * can be cited as.
 */
function renderChunksForPrompt(chunks, doc) {
  const locatorType = doc?.locatorType || "page";
  const unitsByIndex = new Map((doc?.units || []).map((u) => [u.index, u]));

  return chunks
    .map((chunk) => {
      const indexes = chunk.unitIndexes || chunk.pages || [];
      const label =
        unitsByIndex.get(indexes[0])?.label ||
        (indexes.length ? labelFor(locatorType, indexes[0]) : "Unknown");
      return `<chunk id="${chunk.chunkId}" location="${escapeAttribute(label)}">\n${chunk.text}\n</chunk>`;
    })
    .join("\n\n");
}

function escapeAttribute(value) {
  return String(value).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

module.exports = {
  verifyCitations,
  extractCitationBlock,
  renderChunksForPrompt,
  normalizeForMatch,
  trimQuote,
  MAX_QUOTE_CHARS,
};
