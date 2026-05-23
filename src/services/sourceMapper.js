// ============================================
// SourceMapper — Maps highlight snippets to positions in the source document.
// Given text with [Page N] anchors and a snippet, finds the best page,
// section, and paragraph-index match using normalized text comparison.
// ============================================

const MIN_SNIPPET_LENGTH = 8;

// ── Text normalization ───────────────────────────────────────────────────────

/**
 * Normalize text for fuzzy matching: strip diacritics, lowercase, collapse
 * whitespace, remove common punctuation noise.
 */
function normalize(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\w\s.,;:!?()/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── Page-anchored parsing ────────────────────────────────────────────────────

/**
 * Parse page-anchored text (e.g. `[Page 3]\n...`) into an array of page blocks.
 */
function parsePages(fullText) {
  if (!fullText) return [];
  const regex = /\[Page (\d+)\]/g;
  const hits = [];
  let m;
  while ((m = regex.exec(fullText)) !== null) {
    hits.push({ page: parseInt(m[1], 10), start: m.index, headerEnd: m.index + m[0].length });
  }
  if (hits.length === 0) {
    return [{ page: 1, text: fullText, start: 0, end: fullText.length }];
  }
  const pages = [];
  for (let i = 0; i < hits.length; i++) {
    const block = hits[i];
    const end = i + 1 < hits.length ? hits[i + 1].start : fullText.length;
    pages.push({
      page: block.page,
      text: fullText.slice(block.headerEnd, end),
      start: block.headerEnd,
      end,
    });
  }
  return pages;
}

/**
 * Split a page into paragraphs, detecting headings (short ALL-CAPS or Title
 * Case lines) as section starters.
 */
function parseParagraphs(pageText) {
  const lines = pageText.split(/\r?\n/);
  const paragraphs = [];
  let buffer = [];
  let currentSection;

  const HEADING_CAPS = /^([A-Z][A-Z0-9 \-:&()/.,]{2,80})$/;
  const HEADING_TITLE = /^(\d+\.)?\s*[A-Z][A-Za-z0-9]+(\s+[A-Z][A-Za-z0-9]+){0,6}\s*:?\s*$/;

  const flush = () => {
    const joined = buffer.join(" ").trim();
    if (joined.length > 0) {
      paragraphs.push({ text: joined, section: currentSection });
    }
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const isHeading =
      (line.length <= 80 && HEADING_CAPS.test(line)) ||
      (line.length <= 70 && HEADING_TITLE.test(line) && !line.endsWith("."));
    if (isHeading) {
      flush();
      currentSection = line.replace(/:$/, "");
      continue;
    }
    buffer.push(line);
  }
  flush();
  return paragraphs;
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Find the best page + paragraph + section for a snippet within fullText.
 * Returns { page, section, paragraphIndex, snippet } or an empty object if
 * no match is found above the confidence threshold.
 */
function locateSnippet(fullText, snippet) {
  if (!fullText || !snippet || snippet.length < MIN_SNIPPET_LENGTH) return {};

  const pages = parsePages(fullText);
  const needle = normalize(snippet);
  if (!needle) return {};

  // First try a direct normalized substring match across all pages.
  let best = null;
  let paragraphCounter = 0;
  for (const page of pages) {
    const paragraphs = parseParagraphs(page.text);
    for (const p of paragraphs) {
      const hay = normalize(p.text);
      if (!hay) { paragraphCounter++; continue; }
      let score = 0;
      if (hay.includes(needle)) {
        score = needle.length;
      } else {
        // Fallback: overlap of 4-word shingles
        score = shingleOverlap(hay, needle);
      }
      if (score > 0 && (!best || score > best.score)) {
        best = {
          page: page.page,
          section: p.section,
          paragraphIndex: paragraphCounter,
          snippet: trimSnippet(p.text, snippet),
          score,
        };
      }
      paragraphCounter++;
    }
  }

  if (!best) return {};
  // Require at least a tiny overlap to avoid random matches
  if (best.score < Math.min(needle.length * 0.25, 20)) return {};
  const { score: _score, ...ref } = best;
  return ref;
}

/**
 * Count 4-gram word overlaps between two normalized strings.
 */
function shingleOverlap(a, b) {
  const aw = a.split(" ").filter(Boolean);
  const bw = b.split(" ").filter(Boolean);
  if (aw.length < 4 || bw.length < 4) {
    // Short snippets: count exact word matches
    const setA = new Set(aw);
    let hits = 0;
    for (const w of bw) if (setA.has(w)) hits++;
    return hits;
  }
  const makeShingles = (words) => {
    const out = new Set();
    for (let i = 0; i <= words.length - 4; i++) {
      out.add(words.slice(i, i + 4).join(" "));
    }
    return out;
  };
  const setA = makeShingles(aw);
  const setB = makeShingles(bw);
  let hits = 0;
  for (const s of setB) if (setA.has(s)) hits++;
  return hits * 4; // weight shingle matches higher
}

function trimSnippet(paragraphText, wanted) {
  if (!paragraphText) return wanted;
  const normalizedHay = normalize(paragraphText);
  const normalizedNeedle = normalize(wanted);
  const idx = normalizedHay.indexOf(normalizedNeedle);
  if (idx < 0) {
    // Fall back to the first 200 chars of the paragraph
    return paragraphText.slice(0, 200).trim();
  }
  // Approximate original-text offset by scaling
  const approx = Math.floor((idx / normalizedHay.length) * paragraphText.length);
  const start = Math.max(0, approx - 20);
  const end = Math.min(paragraphText.length, start + wanted.length + 40);
  return paragraphText.slice(start, end).trim();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Enrich an array of highlight items with `sourceReference` when missing,
 * by locating each highlight's `text` inside the full document.
 *
 * Also computes a `pageDensity` array: [{ page, count }] sorted desc.
 */
function enrichHighlights(highlights, fullText) {
  if (!Array.isArray(highlights)) return { highlights: [], pageDensity: [] };

  const enriched = highlights.map((h) => {
    if (!h || typeof h !== "object") return h;
    const existing = h.sourceReference && typeof h.sourceReference === "object" ? h.sourceReference : null;
    const hasPage = existing && typeof existing.page === "number";
    if (hasPage) return h;

    const found = locateSnippet(fullText, h.text || (existing && existing.snippet));
    if (!found || (!found.page && !found.section)) {
      return existing ? { ...h, sourceReference: existing } : h;
    }
    return {
      ...h,
      sourceReference: {
        ...(existing || {}),
        ...found,
      },
    };
  });

  const pageCounts = new Map();
  for (const h of enriched) {
    const p = h?.sourceReference?.page;
    if (typeof p === "number") {
      pageCounts.set(p, (pageCounts.get(p) || 0) + 1);
    }
  }
  const pageDensity = Array.from(pageCounts.entries())
    .map(([page, count]) => ({ page, count }))
    .sort((a, b) => b.count - a.count || a.page - b.page);

  return { highlights: enriched, pageDensity };
}

module.exports = {
  enrichHighlights,
  locateSnippet,
  parsePages,
  parseParagraphs,
  normalize,
};
