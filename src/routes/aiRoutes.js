// ============================================
// FILE: routes/aiRoutes.js
// AI feature routes — backward-compatible individual endpoints
// plus a unified POST /api/ai/run endpoint.
// ============================================
const express = require("express");
const router = express.Router();
const aiService = require("../services/aiService");
const aiProvider = require("../services/aiProvider");
const logger = require("../utils/logger");
const aiConfig = require("../config/aiConfig");
const { extractPdfText } = require("../services/pdfExtractor");
const { cleanAllPages, chunkPages } = require("../services/textCleaner");
const {
  saveDocument,
  getDocument,
  deleteDocument,
} = require("../services/docStore");
const { askPdf } = require("../services/aiQa");

// Initialize providers eagerly so startup logs show status
try {
  aiProvider.initialize();
} catch (_) {
  /* logged inside initialize() */
}

// ============================================
// Helpers
// ============================================

/**
 * Build a standardized error response.
 */
function sendError(res, task, err) {
  const code = err.code || "AI_PROVIDER_ERROR";
  const status =
    code === "VALIDATION_ERROR"
      ? 400
      : code === "TIMEOUT"
        ? 504
        : code === "NO_PROVIDER"
          ? 503
          : 500;

  logger.error(`AI route error [${task}]`, { code, message: err.message });

  res.status(status).json({
    success: false,
    provider: aiProvider._initialized ? aiProvider.currentProvider : null,
    task,
    error: {
      code,
      message: err.message || "An unexpected error occurred",
    },
  });
}

/**
 * Validate that a text field doesn't exceed configured limits.
 */
function validateLength(text, fieldName) {
  if (text && text.length > aiConfig.maxPromptLength) {
    const err = new Error(
      `${fieldName} exceeds maximum length of ${aiConfig.maxPromptLength} characters`,
    );
    err.code = "VALIDATION_ERROR";
    throw err;
  }
}

/**
 * Build legacy top-level fields for backward compatibility.
 * The frontend currently reads e.g. result.summary, result.translatedText, etc.
 */
function legacyFields(task, result) {
  const text = result.data?.text || "";
  switch (task) {
    case "summarize":
      return { summary: text };
    case "translate":
      return { translatedText: text };
    case "chat":
      return { response: text };
    case "analyze":
      return { analysis: text, data: result.data?.json || null };
    case "tasks":
    case "extract-tasks":
      return {
        tasks: result.data?.tasks || text,
        data: result.data?.json || null,
      };
    case "fill-form":
      return { filledFormUrl: result.data?.json || text };
    case "classify":
      return { data: result.data?.json || text };
    case "highlight":
      return { data: result.data?.json || text };
    case "explain":
      return { explanation: text };
    case "quiz":
      return { data: result.data?.json || text };
    default:
      return {};
  }
}

// ============================================
// POST /api/ai/run — Unified endpoint
// ============================================
router.post("/run", async (req, res) => {
  const {
    task,
    prompt,
    documentText,
    targetLanguage,
    dataType,
    analysisType,
    contentType,
    history,
    options,
  } = req.body || {};

  if (!task) {
    return sendError(
      res,
      "unknown",
      Object.assign(new Error('"task" field is required'), {
        code: "VALIDATION_ERROR",
      }),
    );
  }

  try {
    validateLength(prompt, "prompt");
    validateLength(documentText, "documentText");

    const file = req.files?.document || req.files?.file || null;
    const formFile = req.files?.form || null;
    const dataSourceFile = req.files?.dataSource || null;

    const result = await aiService.run(task, {
      text: documentText,
      prompt,
      file,
      formFile,
      dataSourceFile,
      targetLanguage,
      dataType,
      analysisType,
      contentType,
      history: typeof history === "string" ? JSON.parse(history) : history,
      options,
    });

    res.json({ ...result, ...legacyFields(task, result) });
  } catch (err) {
    sendError(res, task, err);
  }
});

// ============================================
// Individual endpoints (backward compatible)
// ============================================

// POST /api/ai/summarize
router.post("/summarize", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    validateLength(req.body?.text, "text");

    const result = await aiService.run("summarize", {
      text: req.body?.text,
      file,
    });

    res.json({ ...result, summary: result.data.text });
  } catch (err) {
    sendError(res, "summarize", err);
  }
});

// POST /api/ai/translate
router.post("/translate", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    const { targetLanguage, text } = req.body || {};
    validateLength(text, "text");

    const result = await aiService.run("translate", {
      text,
      file,
      targetLanguage,
    });

    res.json({ ...result, translatedText: result.data.text });
  } catch (err) {
    sendError(res, "translate", err);
  }
});

// POST /api/ai/chat
router.post("/chat", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    const { message, history, documentText } = req.body || {};
    validateLength(message, "message");
    validateLength(documentText, "documentText");

    const result = await aiService.run("chat", {
      text: documentText,
      file,
      prompt: message,
      history: typeof history === "string" ? JSON.parse(history) : history,
    });

    res.json({ ...result, response: result.data.text });
  } catch (err) {
    sendError(res, "chat", err);
  }
});

// POST /api/ai/analyze
router.post("/analyze", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    const { analysisType, text } = req.body || {};
    validateLength(text, "text");

    const result = await aiService.run("analyze", {
      text,
      file,
      analysisType,
    });

    res.json({
      ...result,
      analysis: result.data.text,
      data: result.data.json || null,
    });
  } catch (err) {
    sendError(res, "analyze", err);
  }
});

// POST /api/ai/extract-tasks
router.post("/extract-tasks", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    validateLength(req.body?.text, "text");

    const result = await aiService.run("tasks", {
      text: req.body?.text,
      file,
    });

    res.json({
      ...result,
      tasks: result.data.tasks || result.data.text,
      data: result.data.json || null,
    });
  } catch (err) {
    sendError(res, "extract-tasks", err);
  }
});

// POST /api/ai/fill-form
router.post("/fill-form", async (req, res) => {
  try {
    const formFile = req.files?.form || null;
    const dataSourceFile = req.files?.dataSource || null;
    validateLength(req.body?.text, "text");

    const result = await aiService.run("fill-form", {
      formFile,
      dataSourceFile,
      text: req.body?.text,
    });

    res.json({
      ...result,
      filledFormUrl: result.data.json || result.data.text,
    });
  } catch (err) {
    sendError(res, "fill-form", err);
  }
});

// POST /api/ai/classify
router.post("/classify", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    const { text, filename } = req.body || {};
    validateLength(text, "text");

    const result = await aiService.run("classify", {
      text,
      file,
      filename,
    });

    res.json({ ...result, data: result.data.json || result.data.text });
  } catch (err) {
    sendError(res, "classify", err);
  }
});

// POST /api/ai/highlight
router.post("/highlight", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    validateLength(req.body?.text, "text");

    const result = await aiService.run("highlight", {
      text: req.body?.text,
      file,
    });

    res.json({ ...result, data: result.data.json || result.data.text });
  } catch (err) {
    sendError(res, "highlight", err);
  }
});

// POST /api/ai/highlight-summary — generate a meta summary from a list of
// already-extracted highlights (no source doc required).
router.post("/highlight-summary", async (req, res) => {
  try {
    const { highlights, documentName, options } = req.body || {};
    if (!Array.isArray(highlights) || highlights.length === 0) {
      return sendError(
        res,
        "highlight-summary",
        Object.assign(
          new Error("highlights array is required and must be non-empty"),
          { code: "VALIDATION_ERROR" },
        ),
      );
    }

    const result = await aiService.summarizeHighlights({
      highlights,
      documentName,
      options,
    });

    res.json({ ...result, data: result.data.json || result.data.text });
  } catch (err) {
    sendError(res, "highlight-summary", err);
  }
});

// POST /api/ai/convert-to-task — convert a single highlight (or sentence) into
// a structured task suitable for the app's task system.
router.post("/convert-to-task", async (req, res) => {
  try {
    const { text, context, documentName } = req.body || {};
    validateLength(text, "text");
    if (!text) {
      return sendError(
        res,
        "convert-to-task",
        Object.assign(new Error("text is required"), {
          code: "VALIDATION_ERROR",
        }),
      );
    }

    // Reuse the task extractor with the highlight text + optional context as
    // the "document", yielding a single structured task record.
    const body = context
      ? `Source document: ${documentName || "document"}\n\nContext: ${context}\n\nPassage: ${text}`
      : text;

    const result = await aiService.run("tasks", { text: body });
    const tasks = result.data?.json?.tasks || result.data?.tasks || [];
    const first = Array.isArray(tasks) && tasks.length > 0 ? tasks[0] : null;

    res.json({
      ...result,
      data: first || { action: text, priority: "medium", category: "follow-up" },
    });
  } catch (err) {
    sendError(res, "convert-to-task", err);
  }
});

// POST /api/ai/generate-document
router.post("/generate-document", async (req, res) => {
  try {
    const { prompt, fileType, category, tone, wordCount, audience } = req.body || {};
    validateLength(prompt, "prompt");

    const result = await aiService.run("generate-document", {
      prompt,
      fileType,
      category,
      tone,
      wordCount,
      audience,
    });

    res.json({ ...result, generatedText: result.data.text });
  } catch (err) {
    sendError(res, "generate-document", err);
  }
});

// POST /api/ai/explain
router.post("/explain", async (req, res) => {
  try {
    const { text, mode, depth } = req.body || {};
    validateLength(text, "text");

    const result = await aiService.run("explain", {
      text,
      explainMode: mode,
      explainDepth: depth,
    });

    res.json({ ...result, explanation: result.data.text });
  } catch (err) {
    sendError(res, "explain", err);
  }
});

// POST /api/ai/quiz
router.post("/quiz", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || null;
    const { text, docId, questionType, length, difficulty, weakTopics } = req.body || {};
    validateLength(text, "text");

    // Map length label → question count
    const countMap = { quick: 5, standard: 10, deep: 15 };
    const quizCount = countMap[length] || 10;

    // Prefer retrieval from stored chunks when a docId is provided —
    // this gives the LLM the real document as grounding context.
    let retrievedContext = "";
    if (docId && typeof docId === "string") {
      const doc = getDocument(docId);
      if (doc) {
        retrievedContext = aiService.buildRetrievalContext(doc, {
          weakTopics: Array.isArray(weakTopics) ? weakTopics : [],
          budgetChars: 14000,
        });
      } else {
        logger.warn(`[quiz] docId provided but not found in store: ${docId}`);
      }
    }

    const result = await aiService.run("quiz", {
      text,
      file,
      questionType: questionType || "mixed",
      quizCount,
      quizDifficulty: difficulty || "adaptive",
      weakTopics: Array.isArray(weakTopics) ? weakTopics : [],
      retrievedContext,
    });

    res.json({ ...result, data: result.data.json || result.data.text });
  } catch (err) {
    sendError(res, "quiz", err);
  }
});

// ============================================
// POST /api/ai/ocr-scan — Image OCR + optional AI enhancement
// ============================================
router.post("/ocr-scan", async (req, res) => {
  let worker = null;
  try {
    const file = req.files?.image || req.files?.file;
    if (!file) {
      return res.status(400).json({ success: false, error: "No image file uploaded." });
    }

    const mode = req.body?.mode || "fast"; // 'fast' | 'enhanced'

    const fs = require("fs").promises;
    const imageBuffer = file.data?.length ? file.data : await fs.readFile(file.tempFilePath);

    logger.info(`[ocr-scan] Starting OCR: ${file.name || "image"} (${imageBuffer.length} bytes), mode=${mode}`);

    // Step 1: Tesseract OCR (always runs locally on the server, no external AI for OCR)
    const { createWorker } = require("tesseract.js");
    worker = await createWorker("eng", 1, { logger: () => {} });
    const { data: { text: rawText } } = await worker.recognize(imageBuffer);
    await worker.terminate();
    worker = null;

    const trimmedRaw = (rawText || "").trim();
    logger.info(`[ocr-scan] OCR done, extracted ${trimmedRaw.length} chars`);

    if (!trimmedRaw) {
      return res.json({
        success: false,
        text: "",
        rawText: "",
        enhanced: false,
        mode,
        error: "No readable text found in image",
      });
    }

    let finalText = trimmedRaw;
    let enhanced = false;

    // Step 2: AI enhancement (enhanced mode only — AI cleans OCR text, no image is sent to AI)
    if (mode === "enhanced") {
      try {
        const enhancePrompt =
          "The following text was extracted from an image via OCR. " +
          "Fix spelling/grammar errors caused by OCR noise, remove garbled characters, " +
          "reconstruct broken paragraphs, detect and label obvious headings, " +
          "and preserve the original meaning strictly. " +
          "Do NOT add new content or invent information. " +
          "Return only the cleaned text, nothing else.\n\nOCR TEXT:\n" + trimmedRaw;

        const result = await aiService.run("chat", {
          text: trimmedRaw,
          prompt: enhancePrompt,
        });

        if (result?.data?.text && result.data.text.trim().length > 10) {
          finalText = result.data.text.trim();
          enhanced = true;
        }
      } catch (aiErr) {
        logger.warn("[ocr-scan] AI enhancement failed, falling back to raw OCR:", aiErr.message);
        // finalText stays as trimmedRaw (raw OCR output)
      }
    }

    res.json({
      success: true,
      text: finalText,
      rawText: trimmedRaw,
      enhanced,
      mode,
    });
  } catch (err) {
    if (worker) {
      try { await worker.terminate(); } catch (_) {}
    }
    logger.error("[ocr-scan] Error:", { error: err.message });
    res.status(500).json({ success: false, error: "OCR processing failed.", detail: err.message });
  }
});

// ============================================
// GET /api/ai/status — Provider diagnostics
// ============================================
router.get("/status", (req, res) => {
  try {
    res.json({ success: true, ...aiProvider.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// POST /api/ai/switch-provider — Runtime provider switch
// ============================================
router.post("/switch-provider", (req, res) => {
  try {
    const { provider } = req.body || {};
    if (!provider) {
      return res
        .status(400)
        .json({ success: false, error: '"provider" field is required' });
    }

    aiProvider.switchProvider(provider);
    res.json({
      success: true,
      message: `Switched to ${provider}`,
      status: aiProvider.getStatus(),
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================================
// PDF Text Extraction & AI Q&A Endpoints
// ============================================

// POST /api/ai/extract-pdf — Upload a PDF and extract its text
router.post("/extract-pdf", async (req, res) => {
  try {
    // Accept file from express-fileupload (already handled by middleware)
    const file = req.files?.pdf || req.files?.file || req.files?.document;
    if (!file) {
      return res.status(400).json({ error: "No PDF file uploaded." });
    }

    const filename = file.name || "document.pdf";
    const fs = require("fs").promises;
    const pdfBuffer = file.data?.length ? file.data : await fs.readFile(file.tempFilePath);

    logger.info(
      `[extract-pdf] Starting extraction: ${filename} (${pdfBuffer.length} bytes)`,
    );

    // Step 1: Extract raw text page by page
    const { pages: rawPages, meta } = await extractPdfText(pdfBuffer);

    // Step 2: Clean text (fix hyphenation, remove headers/footers, etc.)
    const cleanedPages = cleanAllPages(rawPages);

    // Step 3: Chunk into LLM-ready segments with page anchors
    const chunks = chunkPages(cleanedPages);

    // Step 4: Store for later Q&A calls
    const docId = saveDocument({
      filename,
      pages: cleanedPages,
      chunks,
      meta: {
        ...meta,
        filename,
        extractedAt: new Date().toISOString(),
      },
    });

    logger.info(
      `[extract-pdf] Done: docId=${docId}, pages=${meta.totalPages}, chunks=${chunks.length}`,
    );

    // Build full extracted text for immediate use
    const fullText = cleanedPages
      .map((p) => `[Page ${p.page}]\n${p.text}`)
      .join("\n\n");

    res.json({
      docId,
      filename,
      totalPages: meta.totalPages,
      scannedPages: meta.scannedPages,
      chunkCount: chunks.length,
      preview: cleanedPages[0]?.text?.slice(0, 300) || "",
      fullText,
      suggestedPrompts: [
        "Summarize this document",
        "What are the key findings or conclusions?",
        "What is this document about?",
        "List the main topics covered",
      ],
    });
  } catch (err) {
    logger.error("[extract-pdf] Error:", { error: err.message });
    res
      .status(500)
      .json({ error: "Failed to extract PDF text.", detail: err.message });
  }
});

// POST /api/ai/ask-pdf — Ask a question about a previously extracted document
router.post("/ask-pdf", async (req, res) => {
  try {
    const { docId, question } = req.body;

    if (!docId || typeof docId !== "string") {
      return res.status(400).json({ error: "docId is required." });
    }
    if (
      !question ||
      typeof question !== "string" ||
      question.trim().length === 0
    ) {
      return res.status(400).json({ error: "question is required." });
    }
    if (question.length > 2000) {
      return res
        .status(400)
        .json({ error: "Question is too long (max 2000 chars)." });
    }

    const doc = getDocument(docId);
    if (!doc) {
      return res.status(404).json({
        error: "Document not found or expired. Please re-upload the PDF.",
      });
    }

    logger.info(
      `[ask-pdf] docId=${docId} question="${question.slice(0, 80)}..."`,
    );

    const result = await askPdf(question.trim(), doc.chunks, doc.meta);

    res.json({
      question: question.trim(),
      answer: result.answer,
      citations: result.citations,
      found: result.found,
      docMeta: {
        filename: doc.meta.filename,
        totalPages: doc.meta.totalPages,
      },
    });
  } catch (err) {
    logger.error("[ask-pdf] Error:", { error: err.message });
    res
      .status(500)
      .json({ error: "Failed to answer question.", detail: err.message });
  }
});

// DELETE /api/ai/doc/:docId — Manually clean up a document
router.delete("/doc/:docId", (req, res) => {
  const { docId } = req.params;
  deleteDocument(docId);
  res.json({ success: true });
});

// ============================================
// Chat With Document — RAG-powered endpoints
// ============================================

const {
  embedDocumentChunks,
  chatWithDocument,
} = require("../services/documentChatService");

// POST /api/ai/extract-document — Upload any document (PDF, DOCX, EPUB) and extract+embed
router.post("/extract-document", async (req, res) => {
  try {
    const file = req.files?.document || req.files?.file || req.files?.pdf;
    if (!file) {
      return res.status(400).json({ error: "No document file uploaded." });
    }

    const fs = require("fs").promises;
    const path = require("path");
    const filename = file.name || "document";
    const ext = path.extname(filename).toLowerCase();
    const mimeType = (file.mimetype || "").toLowerCase();
    const fileBuffer = file.data?.length ? file.data : await fs.readFile(file.tempFilePath);

    logger.info(
      `[extract-document] Starting: ${filename} (${fileBuffer.length} bytes, type=${ext})`,
    );

    let pages, meta;

    // ── PDF extraction ──────────────────────────────────────────
    if (ext === ".pdf" || mimeType === "application/pdf") {
      const result = await extractPdfText(fileBuffer);
      pages = cleanAllPages(result.pages);
      meta = {
        ...result.meta,
        filename,
        fileType: "pdf",
        extractedAt: new Date().toISOString(),
      };
    }
    // ── DOCX extraction ─────────────────────────────────────────
    else if (
      ext === ".docx" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      const rawText = result.value || "";

      // Split DOCX text into synthetic pages (~2000 chars each)
      const CHARS_PER_PAGE = 2000;
      pages = [];
      for (let i = 0; i < rawText.length; i += CHARS_PER_PAGE) {
        const pageText = rawText.slice(i, i + CHARS_PER_PAGE);
        pages.push({
          page: pages.length + 1,
          text: pageText,
          wasOcr: false,
          charCount: pageText.length,
        });
      }
      if (pages.length === 0) {
        pages = [
          { page: 1, text: rawText, wasOcr: false, charCount: rawText.length },
        ];
      }

      pages = cleanAllPages(pages);
      meta = {
        totalPages: pages.length,
        scannedPages: 0,
        hasScannedContent: false,
        filename,
        fileType: "docx",
        extractedAt: new Date().toISOString(),
      };
    }
    // ── EPUB extraction ─────────────────────────────────────────
    else if (ext === ".epub" || mimeType === "application/epub+zip") {
      const {
        extractEpubText: extractEpub,
        chaptersToPages,
      } = require("../services/epubExtractor");

      const { chapters, meta: epubMeta } = await extractEpub(fileBuffer);
      pages = cleanAllPages(chaptersToPages(chapters));
      meta = {
        totalPages: epubMeta.totalChapters,
        scannedPages: 0,
        hasScannedContent: false,
        filename,
        fileType: "epub",
        extractedAt: new Date().toISOString(),
      };
    }
    // ── PPTX extraction ─────────────────────────────────────────
    else if (
      ext === ".pptx" ||
      mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) {
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(fileBuffer);
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

      const rawText = slideTexts.filter((s) => s.trim()).join("\n\n");
      const CHARS_PER_PAGE = 2000;
      pages = [];
      for (let i = 0; i < rawText.length; i += CHARS_PER_PAGE) {
        const pageText = rawText.slice(i, i + CHARS_PER_PAGE);
        pages.push({ page: pages.length + 1, text: pageText, wasOcr: false, charCount: pageText.length });
      }
      if (pages.length === 0) {
        pages = [{ page: 1, text: rawText || "(No text found in slides)", wasOcr: false, charCount: 0 }];
      }
      pages = cleanAllPages(pages);
      meta = {
        totalPages: pages.length,
        scannedPages: 0,
        hasScannedContent: false,
        filename,
        fileType: "pptx",
        extractedAt: new Date().toISOString(),
      };
    }
    // ── XLSX extraction ─────────────────────────────────────────
    else if (
      ext === ".xlsx" ||
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(fileBuffer);

      // Shared strings table holds all text cell values
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

      // Also pull inline strings directly from worksheets
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

      const allStrings = [...strings, ...inlineTexts];
      const rawText = allStrings.join(" ");
      const CHARS_PER_PAGE = 2000;
      pages = [];
      for (let i = 0; i < rawText.length; i += CHARS_PER_PAGE) {
        const pageText = rawText.slice(i, i + CHARS_PER_PAGE);
        pages.push({ page: pages.length + 1, text: pageText, wasOcr: false, charCount: pageText.length });
      }
      if (pages.length === 0) {
        pages = [{ page: 1, text: "(No text content found in spreadsheet)", wasOcr: false, charCount: 0 }];
      }
      pages = cleanAllPages(pages);
      meta = {
        totalPages: pages.length,
        scannedPages: 0,
        hasScannedContent: false,
        filename,
        fileType: "xlsx",
        extractedAt: new Date().toISOString(),
      };
    }
    // ── TXT and other text files ────────────────────────────────
    else if (
      mimeType.startsWith("text/") ||
      [".txt", ".md", ".csv"].includes(ext)
    ) {
      const rawText = fileBuffer.toString("utf-8");
      const CHARS_PER_PAGE = 2000;
      pages = [];
      for (let i = 0; i < rawText.length; i += CHARS_PER_PAGE) {
        const pageText = rawText.slice(i, i + CHARS_PER_PAGE);
        pages.push({
          page: pages.length + 1,
          text: pageText,
          wasOcr: false,
          charCount: pageText.length,
        });
      }
      if (pages.length === 0) {
        pages = [
          { page: 1, text: rawText, wasOcr: false, charCount: rawText.length },
        ];
      }

      meta = {
        totalPages: pages.length,
        scannedPages: 0,
        hasScannedContent: false,
        filename,
        fileType: "txt",
        extractedAt: new Date().toISOString(),
      };
    } else {
      return res
        .status(400)
        .json({ error: `Unsupported file type: ${ext || mimeType}` });
    }

    // Chunk the pages
    const chunks = chunkPages(pages);

    // Generate embeddings for the chunks
    let chunkEmbeddings = [];
    let embeddingProvider = "none";
    try {
      const embResult = await embedDocumentChunks(chunks);
      chunkEmbeddings = embResult.chunkEmbeddings;
      embeddingProvider = embResult.embeddingProvider;
    } catch (embErr) {
      logger.warn(
        "[extract-document] Embedding failed, using chunks without embeddings:",
        embErr.message,
      );
      chunkEmbeddings = chunks.map((c) => ({ ...c, embedding: [] }));
    }

    // Save to document store
    const docId = saveDocument({
      filename,
      pages,
      chunks,
      chunkEmbeddings,
      embeddingProvider,
      meta,
    });

    // Build full text for preview
    const fullText = pages
      .map((p) => `[Page ${p.page}]\n${p.text}`)
      .join("\n\n");

    logger.info(
      `[extract-document] Done: docId=${docId}, pages=${meta.totalPages}, chunks=${chunks.length}, embeddings=${embeddingProvider}`,
    );

    res.json({
      docId,
      filename,
      fileType: meta.fileType,
      totalPages: meta.totalPages,
      scannedPages: meta.scannedPages || 0,
      chunkCount: chunks.length,
      embeddingProvider,
      preview: pages[0]?.text?.slice(0, 300) || "",
      fullText,
      suggestedPrompts: [
        "Summarize this document",
        "What are the key findings or conclusions?",
        "What is this document about?",
        "List the main topics covered",
        "What are the most important points?",
      ],
    });
  } catch (err) {
    logger.error("[extract-document] Error:", { error: err.message });
    res.status(500).json({
      error: "Failed to extract document.",
      detail: err.message,
    });
  }
});

// POST /api/ai/chat-document — Conversational Q&A with a processed document
router.post("/chat-document", async (req, res) => {
  try {
    const { docId, question, history } = req.body;

    if (!docId || typeof docId !== "string") {
      return res.status(400).json({ error: "docId is required." });
    }
    if (
      !question ||
      typeof question !== "string" ||
      question.trim().length === 0
    ) {
      return res.status(400).json({ error: "question is required." });
    }
    if (question.length > 2000) {
      return res
        .status(400)
        .json({ error: "Question is too long (max 2000 chars)." });
    }

    const doc = getDocument(docId);
    if (!doc) {
      return res.status(404).json({
        error: "Document not found or expired. Please re-upload the document.",
      });
    }

    logger.info(
      `[chat-document] docId=${docId} question="${question.slice(0, 80)}..."`,
    );

    // Parse history if it's a string
    const parsedHistory =
      typeof history === "string" ? JSON.parse(history) : history || [];

    // Use embedding-based retrieval if embeddings are available
    let result;
    if (
      doc.chunkEmbeddings &&
      doc.chunkEmbeddings.length > 0 &&
      doc.chunkEmbeddings[0].embedding &&
      doc.chunkEmbeddings[0].embedding.length > 0
    ) {
      result = await chatWithDocument(
        question.trim(),
        doc.chunkEmbeddings,
        doc.meta,
        parsedHistory,
        doc.embeddingProvider,
      );
    } else {
      // Fallback to keyword-based Q&A
      result = await askPdf(question.trim(), doc.chunks, doc.meta);
      result.retrievedChunks = [];
    }

    res.json({
      question: question.trim(),
      answer: result.answer,
      citations: result.citations,
      found: result.found,
      retrievedChunks: result.retrievedChunks || [],
      docMeta: {
        filename: doc.meta.filename,
        fileType: doc.meta.fileType || "pdf",
        totalPages: doc.meta.totalPages,
      },
    });
  } catch (err) {
    logger.error("[chat-document] Error:", { error: err.message });
    res.status(500).json({
      error: "Failed to answer question.",
      detail: err.message,
    });
  }
});

module.exports = router;
