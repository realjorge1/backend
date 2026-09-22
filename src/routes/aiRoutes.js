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
  findByContentHash,
} = require("../services/docStore");
const { askPdf } = require("../services/aiQa");
const apiConfig = require("../config/apiConfig");
const { getCapabilities } = require("../ai/capabilities");
const { authStatsHandler } = require("../middleware/aiAuth");
const { requireAdmin } = require("../middleware/requireAdmin");

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

  // A task run against a docId that no longer exists answers with the
  // document-route error body (contract C4), not the task error body: the
  // app keys off `code` to re-upload and retry once.
  if (code === "DOC_NOT_FOUND") {
    logger.warn(`AI route [${task}]: document not found`);
    return sendDocNotFound(res);
  }
  if (code === "STORE_UNAVAILABLE") {
    return sendStoreUnavailable(res, err);
  }

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
 * The v2 fields every whole-document task route accepts (contract C5).
 * Absent from the body, they resolve to undefined and the route behaves
 * exactly as it did before.
 */
function documentTaskParams(req) {
  const body = req.body || {};
  const instruction = body.instruction;

  if (instruction !== undefined && instruction !== null && instruction !== "") {
    if (typeof instruction !== "string") {
      const err = new Error("instruction must be a string");
      err.code = "VALIDATION_ERROR";
      throw err;
    }
    if (instruction.length > apiConfig.tasks.maxInstructionChars) {
      const err = new Error(
        `instruction exceeds maximum length of ${apiConfig.tasks.maxInstructionChars} characters`,
      );
      err.code = "VALIDATION_ERROR";
      throw err;
    }
  }

  return {
    docId: typeof body.docId === "string" && body.docId ? body.docId : undefined,
    instruction: instruction || undefined,
    userHash: req.userHash,
  };
}

/**
 * Validate that a text field doesn't exceed configured limits.
 * Applies to text sent in the request, never to a stored document — those are
 * bounded by aiConfig.maxDocumentLength and reported through coverage.
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
 * A document route was given a docId that isn't in the store (or has expired,
 * or belongs to another user). The app re-uploads once and retries once.
 */
function sendDocNotFound(res) {
  return res.status(404).json({
    success: false,
    code: "DOC_NOT_FOUND",
    error: "Document not found or expired. Please re-upload the document.",
  });
}

/**
 * The document database is unreachable. This is one of the few genuine
 * "this instance cannot serve the request" cases, so 503 is correct here and
 * failing over to the other server is the right move.
 */
function sendStoreUnavailable(res, err) {
  logger.error("Document store unavailable", { error: err.message });
  return res.status(503).json({
    success: false,
    code: "UNAVAILABLE",
    error: "Document storage is temporarily unavailable. Please try again.",
  });
}

/**
 * Load a stored document, answering the request directly when it can't be
 * served. Returns null when a response has already been sent.
 */
async function fetchDocument(req, res, docId) {
  try {
    const doc = await getDocument(docId, { userHash: req.userHash });
    if (!doc) {
      sendDocNotFound(res);
      return null;
    }
    return doc;
  } catch (err) {
    if (err.code === "STORE_UNAVAILABLE") {
      sendStoreUnavailable(res, err);
      return null;
    }
    throw err;
  }
}

/** sha256 of the uploaded bytes — used to skip re-processing the same file. */
function hashContent(buffer) {
  return require("crypto").createHash("sha256").update(buffer).digest("hex");
}

/**
 * The response body shared by /extract-pdf and /extract-document. Keeps every
 * field both routes returned before and adds the v2 fields from contract C4.
 */
function buildExtractResponse(doc, { includeFullText = true, suggestedPrompts } = {}) {
  const units = doc.units || [];
  const fullText = units
    .map((u) => `[${u.label}]\n${u.text}`)
    .join("\n\n");

  const body = {
    docId: doc.docId,
    filename: doc.filename,
    fileType: doc.fileType,
    totalPages: doc.totalUnits,
    scannedPages: doc.meta?.scannedPages || 0,
    chunkCount: doc.chunks?.length || 0,
    embeddingProvider: doc.embedding?.provider || "none",
    preview: units[0]?.text?.slice(0, 300) || "",
    // v2 additions
    locatorType: doc.locatorType,
    persisted: Boolean(doc.persisted),
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt).toISOString() : null,
    retrievalMode: doc.embedding ? "hybrid" : "keyword",
    embedding: doc.embedding
      ? {
          provider: doc.embedding.provider,
          model: doc.embedding.model,
          dims: doc.embedding.dims,
        }
      : null,
    contentHash: doc.contentHash || null,
    suggestedPrompts,
  };

  if (includeFullText) body.fullText = fullText;
  return body;
}

/** `?includeFullText=0` opts out of the (potentially huge) fullText field. */
function wantsFullText(req) {
  const value = req.query?.includeFullText;
  return !(value === "0" || value === "false");
}

/**
 * Assemble a task response: the standard envelope, the legacy top-level
 * fields, and the v2 additions.
 *
 * Several routes have always overwritten `data` with their JSON payload
 * (`data: result.data.json`), which means the envelope's `data.coverage`
 * would be invisible on exactly those routes. Coverage and format are
 * therefore exposed at the top level for every task route, and also merged
 * into the legacy payload when that payload is a plain object — so a client
 * can read either place. See the report: this is the one place where C5's
 * "data gains coverage" could not hold literally.
 */
function taskResponse(result, legacy = {}) {
  const coverage = result.data?.coverage;
  const format = result.data?.format;
  const body = { ...result, ...legacy, coverage, format };

  const replacedData =
    body.data &&
    body.data !== result.data &&
    typeof body.data === "object" &&
    !Array.isArray(body.data);
  if (replacedData) {
    body.data = { ...body.data, coverage, format };
  }

  return body;
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
      ...documentTaskParams(req),
      text: req.body?.text,
      file,
    });

    res.json(taskResponse(result, { summary: result.data.text }));
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
      ...documentTaskParams(req),
      text,
      file,
      targetLanguage,
    });

    res.json(taskResponse(result, { translatedText: result.data.text }));
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

    res.json(taskResponse(result, { response: result.data.text }));
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
      ...documentTaskParams(req),
      text,
      file,
      analysisType,
    });

    res.json(
      taskResponse(result, {
        analysis: result.data.text,
        data: result.data.json || null,
      }),
    );
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
      ...documentTaskParams(req),
      text: req.body?.text,
      file,
    });

    res.json(
      taskResponse(result, {
        tasks: result.data.tasks || result.data.text,
        data: result.data.json || null,
      }),
    );
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

    res.json(taskResponse(result, { data: result.data.json || result.data.text }));
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
      ...documentTaskParams(req),
      text: req.body?.text,
      file,
    });

    res.json(taskResponse(result, { data: result.data.json || result.data.text }));
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

    res.json(taskResponse(result, { data: result.data.json || result.data.text }));
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

    res.json(taskResponse(result, { generatedText: result.data.text }));
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
      ...documentTaskParams(req),
      text,
      explainMode: mode,
      explainDepth: depth,
    });

    res.json(taskResponse(result, { explanation: result.data.text }));
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
      let doc;
      try {
        doc = await getDocument(docId, { userHash: req.userHash });
      } catch (err) {
        if (err.code === "STORE_UNAVAILABLE") return sendStoreUnavailable(res, err);
        throw err;
      }
      if (doc) {
        retrievedContext = aiService.buildRetrievalContext(doc, {
          weakTopics: Array.isArray(weakTopics) ? weakTopics : [],
          budgetChars: 14000,
        });
      } else if (!text) {
        // No stored document and nothing to fall back on.
        return sendDocNotFound(res);
      } else {
        // Older app builds send both a docId and the document text. Falling
        // back to the text keeps them working when the docId has expired.
        logger.warn("[quiz] docId not found; falling back to supplied text");
      }
    }

    const result = await aiService.run("quiz", {
      ...documentTaskParams(req),
      text,
      file,
      questionType: questionType || "mixed",
      quizCount,
      quizDifficulty: difficulty || "adaptive",
      weakTopics: Array.isArray(weakTopics) ? weakTopics : [],
      retrievedContext,
    });

    res.json(taskResponse(result, { data: result.data.json || result.data.text }));
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
// GET /api/ai/status — Provider diagnostics + capability discovery
// Never requires auth: the app reads this before it has an app key.
// ============================================
router.get("/status", (req, res) => {
  try {
    res.json({
      success: true,
      ...aiProvider.getStatus(),
      apiVersion: apiConfig.apiVersion,
      capabilities: getCapabilities(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================
// GET /api/ai/admin/auth-stats — what monitor mode has seen (admin only)
// ============================================
router.get("/admin/auth-stats", authStatsHandler);

// ============================================
// POST /api/ai/switch-provider — Runtime provider switch (admin only)
// Returns 404 when no ADMIN_TOKEN is configured, so the route simply doesn't
// exist on a server that hasn't opted in.
// ============================================
router.post("/switch-provider", requireAdmin, (req, res) => {
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

    const contentHash = hashContent(pdfBuffer);
    const suggestedPrompts = [
      "Summarize this document",
      "What are the key findings or conclusions?",
      "What is this document about?",
      "List the main topics covered",
    ];

    // Same bytes, same user, still alive → hand back the existing document.
    const existingId = await findByContentHash(contentHash, req.userHash);
    if (existingId) {
      const existing = await getDocument(existingId, { userHash: req.userHash });
      if (existing) {
        logger.info(`[extract-pdf] Reusing docId=${existingId} (identical upload)`);
        return res.json(
          buildExtractResponse(existing, {
            includeFullText: wantsFullText(req),
            suggestedPrompts,
          }),
        );
      }
    }

    const ingested = await ingestDocument({
      buffer: pdfBuffer,
      filename,
      ext: ".pdf",
      mimeType: "application/pdf",
      contentHash,
      userHash: req.userHash,
    });

    logger.info(
      `[extract-pdf] Done: docId=${ingested.docId}, pages=${ingested.totalUnits}, ` +
        `chunks=${ingested.chunks.length}, embeddings=${ingested.embedding?.provider || "none"}`,
    );

    res.json(
      buildExtractResponse(ingested, {
        includeFullText: wantsFullText(req),
        suggestedPrompts,
      }),
    );
  } catch (err) {
    if (err.code === "STORE_UNAVAILABLE") return sendStoreUnavailable(res, err);
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

    const doc = await fetchDocument(req, res, docId);
    if (!doc) return undefined;

    logger.info(`[ask-pdf] docId=${docId} (${question.length} char question)`);

    const result = await askPdf(question.trim(), doc);

    res.json({
      question: question.trim(),
      answer: result.answer,
      citations: result.citations,
      found: result.found,
      retrieval: result.retrieval,
      docMeta: {
        filename: doc.meta.filename,
        totalPages: doc.meta.totalPages,
      },
    });
  } catch (err) {
    if (err.code === "STORE_UNAVAILABLE") return sendStoreUnavailable(res, err);
    logger.error("[ask-pdf] Error:", { error: err.message });
    res
      .status(500)
      .json({ error: "Failed to answer question.", detail: err.message });
  }
});

// DELETE /api/ai/doc/:docId — Permanently remove a document
router.delete("/doc/:docId", async (req, res) => {
  try {
    await deleteDocument(req.params.docId);
    res.json({ success: true });
  } catch (err) {
    if (err.code === "STORE_UNAVAILABLE") return sendStoreUnavailable(res, err);
    logger.error("[delete-doc] Error:", { error: err.message });
    res.status(500).json({ success: false, error: "Failed to delete document." });
  }
});

// ============================================
// Chat With Document — RAG-powered endpoints
// ============================================

const { chatWithDocument } = require("../services/documentChatService");
const { ingestDocument } = require("../services/documentIngest");

// POST /api/ai/extract-document — Upload any supported document and extract+embed
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
    const fileBuffer = file.data?.length
      ? file.data
      : await fs.readFile(file.tempFilePath);

    logger.info(
      `[extract-document] Starting: ${filename} (${fileBuffer.length} bytes, type=${ext})`,
    );

    const contentHash = hashContent(fileBuffer);
    const suggestedPrompts = [
      "Summarize this document",
      "What are the key findings or conclusions?",
      "What is this document about?",
      "List the main topics covered",
      "What are the most important points?",
    ];

    // Same bytes, same user, still alive → hand back the existing document.
    const existingId = await findByContentHash(contentHash, req.userHash);
    if (existingId) {
      const existing = await getDocument(existingId, { userHash: req.userHash });
      if (existing) {
        logger.info(
          `[extract-document] Reusing docId=${existingId} (identical upload)`,
        );
        return res.json(
          buildExtractResponse(existing, {
            includeFullText: wantsFullText(req),
            suggestedPrompts,
          }),
        );
      }
    }

    const ingested = await ingestDocument({
      buffer: fileBuffer,
      filename,
      ext,
      mimeType,
      contentHash,
      userHash: req.userHash,
    });

    logger.info(
      `[extract-document] Done: docId=${ingested.docId}, ` +
        `${ingested.locatorType}s=${ingested.totalUnits}, chunks=${ingested.chunks.length}, ` +
        `embeddings=${ingested.embedding?.provider || "none"}`,
    );

    res.json(
      buildExtractResponse(ingested, {
        includeFullText: wantsFullText(req),
        suggestedPrompts,
      }),
    );
  } catch (err) {
    if (err.code === "STORE_UNAVAILABLE") return sendStoreUnavailable(res, err);
    if (err.code === "UNSUPPORTED_FILE_TYPE") {
      return res.status(400).json({ error: err.message });
    }
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

    const doc = await fetchDocument(req, res, docId);
    if (!doc) return undefined;

    logger.info(`[chat-document] docId=${docId} (${question.length} char question)`);

    // Parse history if it's a string
    const parsedHistory =
      typeof history === "string" ? JSON.parse(history) : history || [];

    // One retrieval path for every document: hybrid when the document has
    // real embeddings and the question could be embedded the same way,
    // keyword otherwise.
    const result = await chatWithDocument(question.trim(), doc, parsedHistory);

    res.json({
      question: question.trim(),
      answer: result.answer,
      citations: result.citations,
      found: result.found,
      retrievedChunks: result.retrievedChunks || [],
      retrieval: result.retrieval,
      docMeta: {
        filename: doc.meta.filename,
        fileType: doc.meta.fileType || "pdf",
        totalPages: doc.meta.totalPages,
      },
    });
  } catch (err) {
    if (err.code === "STORE_UNAVAILABLE") return sendStoreUnavailable(res, err);
    logger.error("[chat-document] Error:", { error: err.message });
    res.status(500).json({
      error: "Failed to answer question.",
      detail: err.message,
    });
  }
});

module.exports = router;
