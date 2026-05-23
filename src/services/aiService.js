// ============================================
// FILE: services/aiService.js
// Unified AI Service — single entry point for all AI features.
// Routes prompt construction, provider dispatch, and response
// normalization through one clean interface.
// ============================================
const aiProvider = require("./aiProvider");
const documentProcessor = require("./documentProcessor");
const aiConfig = require("../config/aiConfig");
const logger = require("../utils/logger");
const { enrichHighlights, locateSnippet, normalize } = require("./sourceMapper");
const { mapReduceLong, CHUNK_THRESHOLD } = require("./aiChunker");

// Categories tuned per detected document type. The model is free to use its
// own labels if none of these apply — we never coerce the output.
const CATEGORY_PROFILES = {
  invoice: ["amount", "due_date", "vendor", "line_item", "tax", "payment_terms", "financial"],
  receipt: ["amount", "vendor", "date", "line_item", "tax", "financial"],
  contract: ["obligation", "party", "term", "clause", "risk", "important_date", "financial"],
  agreement: ["obligation", "party", "term", "clause", "risk", "important_date"],
  research_paper: ["finding", "method", "conclusion", "definition", "key_finding"],
  report: ["key_finding", "conclusion", "recommendation", "risk", "financial", "important_date"],
  financial_statement: ["financial", "amount", "risk", "key_finding", "conclusion"],
  resume: ["skill", "experience", "achievement", "education", "key_finding"],
  letter: ["action_required", "important_date", "key_finding", "conclusion"],
  proposal: ["action_required", "financial", "important_date", "risk", "conclusion"],
  form: ["field", "instruction", "action_required", "important_date"],
  manual: ["instruction", "warning", "definition", "risk"],
};

const DEFAULT_CATEGORIES = [
  "key_finding",
  "action_required",
  "important_date",
  "financial",
  "risk",
  "definition",
  "conclusion",
];

// ============================================
// Prompt templates per task type
// ============================================
const PROMPT_TEMPLATES = {
  summarize: {
    system:
      "You are a professional document summarizer. Be concise, accurate, and useful.",
    userPrompt: (text, mode) => {
      const instructions = {
        short:
          "Write a concise 2-3 sentence summary that captures the core purpose, main finding, and most important takeaway. Be direct.",
        detailed:
          "Write a comprehensive summary in 4-6 paragraphs. Cover the document's purpose, main sections, key points, conclusions, and any important data or figures. Preserve structure with clear paragraph breaks.",
        bullets:
          'Return a bullet-point summary. Use "## Section Name" headers where appropriate. Each bullet should be one clear, actionable or informative point. Aim for 8-12 bullets total.',
      };
      const instruction = instructions[mode] || instructions.detailed;
      return `${instruction}\n\nDocument:\n${text}`;
    },
  },

  translate: {
    system: (lang) =>
      `You are a professional translator with expertise in ${lang}. ` +
      "Translate text accurately and naturally. Preserve all formatting, paragraph breaks, " +
      "numbered lists, and structure. Do not add translator notes, explanations, or any content " +
      "not in the original. Provide only the translation.",
    userPrompt: (text) =>
      `Translate the following document. Preserve all formatting exactly.\n\n${text}`,
  },

  analyze: {
    system:
      "You are an expert document analyst. Return JSON only, no markdown. Provide a " +
      "structured, dashboard-ready analysis with insights, sentiment, strengths, " +
      "weaknesses, recommendations, and a short narrative summary.",
    userPrompt: (text, analysisType) =>
      `Analyze this document (${analysisType || "comprehensive"} analysis).
Return a JSON object with these exact keys:
- "summary": 2-3 sentence narrative summary
- "sentiment": one of "positive" | "neutral" | "negative" | "mixed"
- "sentimentScore": number between -1 and 1
- "insights": array of 4-8 objects { "title": short title, "detail": 1-2 sentence explanation, "sourceQuote": short verbatim quote from the document (optional) }
- "strengths": array of 3-6 short strings
- "weaknesses": array of 3-6 short strings (risks, gaps, issues)
- "recommendations": array of 3-6 actionable short strings
- "topics": array of up to 6 topic tags
- "readability": object { "level": "easy" | "moderate" | "advanced", "notes": one sentence }

Document:
${text}

Return ONLY valid JSON.`,
  },

  tasks: {
    system:
      "You are an expert at extracting action items and tasks from documents. Return JSON only, no markdown, no code fences.",
    userPrompt: (text) =>
      `Extract every action item, task, follow-up, decision, and commitment from this document.
Return a JSON object with key "tasks" containing an array. Each task object must have:
- "id": unique string identifier (e.g. "task-1", "task-2", ...)
- "action": clear description of what must be done (short imperative sentence)
- "owner": person or team responsible (or "Unassigned" if unknown)
- "deadline": due date or timeframe in natural language (or "" if unknown)
- "priority": one of "urgent" | "high" | "medium" | "low"
  - urgent: must happen immediately / blocking
  - high: important, within days
  - medium: within weeks
  - low: nice to have / no strict deadline
- "context": one sentence verbatim or closely paraphrased from the document explaining why this task exists
- "category": one of "follow-up" | "decision" | "deliverable" | "communication" | "review" | "other"

If no tasks are found, return {"tasks": []}.

Document:
${text}

Return ONLY valid JSON. Do not wrap in markdown code fences.`,
  },

  "fill-form": {
    system:
      "You are a form-filling assistant. Given a form structure and optional " +
      "data source, extract relevant information and map it to the form fields. " +
      "Return the result as valid JSON with field names as keys and values filled in.",
    userPrompt: (formText, dataText) =>
      `Fill this form using the provided data.\n\nForm structure:\n${formText}\n\n` +
      (dataText
        ? `Data source:\n${dataText}`
        : "No additional data source provided — infer reasonable values from the form context."),
  },

  chat: {
    system: (docContext) =>
      docContext
        ? "You are athemi, a helpful document assistant. Answer questions about the " +
          "document below precisely and clearly. Reference specific parts of " +
          `the document when relevant.\n\nDocument:\n${docContext}`
        : "You are athemi, a helpful assistant. Provide clear, accurate, and well-structured answers.",
    userPrompt: (message) => message,
  },

  classify: {
    system:
      "You are a document classification expert. Return JSON only, no markdown.",
    userPrompt: (text, filename) =>
      `Analyze this document and return a JSON object with these exact keys:
- "type": one of: invoice | resume | contract | report | research_paper | letter | form | receipt | agreement | proposal | manual | financial_statement | other
- "confidence": integer 0-100
- "suggestedFilename": a clean, descriptive filename (no spaces, use underscores) ending in .pdf. Example: "Invoice_Acme_Corp_March_2026.pdf"
- "summary": one sentence describing what this document is and its purpose
- "keyEntities": array of up to 5 important names, organizations, or dates found

Original filename: ${filename || "document.pdf"}

Document (first portion):
${text.slice(0, 5000)}

Return ONLY valid JSON.`,
  },

  highlight: {
    system:
      "You are an expert at identifying critical information in documents. Return JSON only, no markdown. " +
      "You find the most actionable, decision-relevant information and explain WHY it matters in business / impact terms.",
    userPrompt: (text, documentType, allowedCategories) => {
      const categoryList = Array.isArray(allowedCategories) && allowedCategories.length
        ? allowedCategories.join(" | ")
        : "key_finding | action_required | important_date | financial | risk | definition | conclusion | amount | due_date | vendor | finding | method | obligation | party | clause";
      const typeHint = documentType && documentType !== "other"
        ? `This document appears to be a ${documentType}. Adapt categories to what's most useful for this type.`
        : "";
      return `Identify the 10-15 most important sentences or short passages in this document.
${typeHint}

Return a JSON object with two keys: "highlights" and "meta".

"highlights" must be an array. Each item must include:
- "text": the EXACT sentence or passage from the document (copy it verbatim, no paraphrasing)
- "importance": one of "critical" | "high" | "medium"
- "category": one of ${categoryList}
- "reason": a CONTEXTUAL explanation (1 sentence) of WHY this matters — describe the downstream impact, not the surface category. Bad: "Key financial figure". Good: "This directly impacts Q2 budgeting decisions and signals a 15% increase in spending capacity."
- "confidence": integer 0-100 — how confident you are that this is among the most important items
- "sourceReference": object with:
    - "page": page number if visible from [Page N] anchors in the text (otherwise omit)
    - "section": nearest heading or section label if identifiable (otherwise omit)
    - "snippet": a 5-12 word verbatim phrase from the passage that can be used to locate it in the source

"meta" must be an object with:
- "summary": array of 3-5 short bullet strings that together summarize what the highlights collectively reveal
- "keyThemes": array of 3-6 short theme/topic labels that emerge across the highlights
- "documentType": short label for the detected document type (or "other")

Document:
${text}

Return ONLY valid JSON.`;
    },
  },

  "highlight-summary": {
    system:
      "You synthesize executive summaries from a list of key highlights. Return JSON only, no markdown.",
    userPrompt: (highlights, documentName) => {
      const items = highlights
        .map((h, i) => `${i + 1}. [${h.importance || "medium"} / ${h.category || "general"}] ${h.text}`)
        .join("\n");
      return `Given the following highlights${documentName ? ` from "${documentName}"` : ""}, produce a meta summary.

Highlights:
${items}

Return a JSON object with exactly these keys:
- "summary": array of 3-5 concise bullet strings capturing what these highlights collectively reveal
- "keyThemes": array of 3-6 short theme / topic labels that emerge across the highlights

Return ONLY valid JSON.`;
    },
  },

  explain: {
    system: (mode) => {
      const systems = {
        simple:
          "You are an expert at making complex text easy to understand for everyone.",
        plain:
          "You are an expert at making complex text easy to understand for everyone.",
        professional:
          "You are a professional writer rephrasing text in clear, confident business language.",
        legal:
          "You are a plain-language legal expert helping non-lawyers understand legal documents.",
        medical:
          "You are a health literacy specialist helping patients understand medical content.",
        technical:
          "You are a tech educator skilled at explaining technical concepts to non-technical people.",
        bullet:
          "You are an editor who distills text into a crisp bulleted breakdown.",
      };
      return systems[mode] || systems.simple;
    },
    userPrompt: (text, mode, depth) => {
      const depthInstruction =
        depth === "short"
          ? "Keep it short — under 80 words."
          : depth === "deep"
            ? "Go deep — provide a thorough explanation with examples, definitions, and context."
            : "Medium depth — 2-4 paragraphs or 6-10 bullets.";
      const prompts = {
        simple: `Rewrite this in simple, clear language a 14-year-old could understand. Keep the same meaning but remove jargon. If a term is essential, briefly define it. ${depthInstruction}\n\nText:\n${text}`,
        plain: `Rewrite this in simple, clear language a 14-year-old could understand. Keep the same meaning but remove jargon. If a term is essential, briefly define it. ${depthInstruction}\n\nText:\n${text}`,
        professional: `Rewrite this in a professional business tone suitable for stakeholders. Keep accuracy, use clean structure, use headings or short paragraphs. ${depthInstruction}\n\nText:\n${text}`,
        legal: `Explain what this legal text actually means in plain English. Cover: 1) What it says, 2) Key obligations or rights per party, 3) Important conditions or exceptions, 4) Red flags or risks. ${depthInstruction}\n\nLegal text:\n${text}`,
        medical: `Explain this medical content clearly for a patient. Cover: 1) What this means, 2) What the patient should know or do, 3) Important warnings or next steps. ${depthInstruction}\n\nMedical text:\n${text}`,
        technical: `Explain this technical content to a non-technical person using analogies and everyday examples. Avoid unexplained acronyms. ${depthInstruction}\n\nTechnical text:\n${text}`,
        bullet: `Rewrite this as a clean bulleted breakdown. Group related points under short "## Heading" sections where helpful. Each bullet must be a single, clear point. ${depthInstruction}\n\nText:\n${text}`,
      };
      return prompts[mode] || prompts.simple;
    },
  },

  "generate-document": {
    system: (tone, audience, fileType) => {
      const toneDesc = tone || "professional";
      const audienceDesc = audience || "general";
      const isPpt = fileType === "ppt" || fileType === "pptx";
      if (isPpt) {
        return (
          `You are an expert presentation designer producing ${toneDesc}-tone slides for a ${audienceDesc} audience. ` +
          "Structure your ENTIRE response as a slide presentation. " +
          "Format EVERY slide exactly as follows:\n" +
          "## SLIDE N: [Slide Title]\n" +
          "- Bullet point one\n" +
          "- Bullet point two\n" +
          "- Bullet point three\n\n" +
          "Rules: Begin with SLIDE 1 as the title/introduction slide. Each slide must have 3-6 concise bullet points. " +
          "Keep each bullet to one clear idea (max 15 words). Do NOT include any text outside the slide format."
        );
      }
      return (
        `You are an expert document writer producing ${toneDesc}-tone content for a ${audienceDesc} audience. ` +
        "Write well-structured, complete documents with clear headings, coherent paragraphs, and professional formatting. " +
        "Use Markdown: ## for section headings, ### for subsections, **bold** for key terms, - for bullet lists."
      );
    },
    userPrompt: (prompt, category, wordCount, fileType) => {
      const wc = wordCount ? `Target length: approximately ${wordCount} words.` : "";
      const cat = category ? `Document category: ${category}.` : "";
      const isPpt = fileType === "ppt" || fileType === "pptx";
      if (isPpt) {
        const slideCount = wordCount >= 3000 ? "15-20" : wordCount >= 1500 ? "10-15" : "7-10";
        return `${cat}\n\nCreate a ${slideCount}-slide presentation about:\n\n${prompt}\n\nFormat each slide as '## SLIDE N: Title' with bullet points.`.trim();
      }
      return `${cat} ${wc}\n\nCreate a complete, high-quality document based on the following description:\n\n${prompt}\n\nWrite the full document content now.`.trim();
    },
  },

  quiz: {
    system:
      "You are a STRICT DOCUMENT-GROUNDED assessment generator. You NEVER use outside knowledge or general facts. " +
      "Every question, answer, and explanation MUST be directly supported by verbatim content in the provided document context. " +
      "If the document does not clearly state something, you DO NOT ask a question about it. " +
      "Return JSON only — no markdown, no fences, no explanation outside the JSON.",
    userPrompt: (text, questionType, count, difficulty, weakTopics) => {
      const n = Math.min(Math.max(parseInt(count) || 5, 3), 20);

      const typeInstr = {
        mcq: `Generate up to ${n} multiple-choice questions. Each must have exactly 4 answer options, exactly one of which is correct and copied verbatim from the document.`,
        true_false: `Generate up to ${n} true/false questions. Each statement must be answerable strictly from the document context.`,
        short: `Generate up to ${n} short-answer (theory) questions. The model answer must be a paraphrase of content that appears in the document.`,
        mixed: `Generate up to ${n} questions mixing multiple-choice, true/false, and short-answer types roughly equally.`,
      };

      const diffInstr = difficulty === "adaptive"
        ? "Vary the difficulty from easy to hard — but easiness/hardness must never come from difficulty of outside knowledge, only from how central / subtle the document content is."
        : `All questions must be ${difficulty} difficulty.`;

      const weakTopicInstr = weakTopics && weakTopics.length
        ? `\nFocus primarily on these topics where the user previously struggled (only if the document covers them): ${weakTopics.join(", ")}.`
        : "";

      return `${typeInstr[questionType] || typeInstr.mixed} ${diffInstr}${weakTopicInstr}

ABSOLUTE GROUNDING RULES — NO EXCEPTIONS:
1. Generate questions ONLY from content that appears verbatim in the Document Context below.
2. DO NOT use outside knowledge, general facts, or textbook knowledge. You are a retrieval reader, not a teacher.
3. If the answer to a candidate question is not explicitly in the Document Context, DO NOT create that question. Skip it.
4. Every question MUST include a "source_text" field containing a verbatim passage (20–400 chars) copied character-for-character from the Document Context that directly supports the answer. This is non-negotiable.
5. If you cannot produce ${n} questions that fully meet these rules, return fewer questions. Returning fewer grounded questions is correct. Fabricating is forbidden.
6. If the document lacks sufficient distinct facts to generate at least 3 grounded questions, return { "questions": [], "insufficient": true, "reason": "Document lacks enough explicit content" }.

Return a JSON object with key "questions" containing an array. Each element must have EXACTLY these fields:
- "id": unique string such as "q1", "q2", etc.
- "type": "mcq" | "true_false" | "short"
- "question": the question text — must be answerable purely from source_text
- "options": array of 4 option strings — ONLY for "mcq" type; OMIT for true_false and short. Distractors must be plausible but must NOT appear as the correct answer anywhere in source_text
- "answer": for mcq: the exact option string that is correct; for true_false: "True" or "False"; for short: a model sample answer (1-3 sentences) paraphrasing source_text
- "explanation": one clear sentence explaining why, referencing ONLY what source_text states
- "source_text": REQUIRED. A verbatim 20–400 character passage copied from the Document Context that proves the answer. Do not paraphrase. Copy exactly, preserving punctuation
- "source_reference": REQUIRED. An object describing where the source_text is located:
    - "page": page number if the passage sits under a [Page N] anchor
    - "slide": slide number if under a [Slide N] anchor
    - "section": nearest heading / section label if identifiable (optional)
    - "snippet": a 5–12 word verbatim phrase from source_text for locating it in the UI
- "difficulty": "easy" | "medium" | "hard"
- "topic": a 2–4 word topic label drawn from what the source_text discusses

Return ONLY valid JSON. No markdown, no text before or after the JSON.

Document Context (this is the ONLY ground truth you may use):
${text}`;
    },
  },
};

// ============================================
// AI Service
// ============================================
class AIService {
  /**
   * Run an AI task with standardized input/output.
   * This is the SINGLE entry point for all AI features.
   *
   * @param {string} task  One of: summarize, translate, analyze,
   *                       tasks, extract-tasks, fill-form, chat
   * @param {object} params
   *   text           - pre-extracted document text
   *   prompt         - user prompt / message
   *   file           - express-fileupload file object
   *   formFile       - form file (fill-form)
   *   dataSourceFile - data source file (fill-form)
   *   targetLanguage - target language (translate)
   *   analysisType   - analysis focus (analyze)
   *   history        - conversation history [{role, content}]
   *   options        - { temperature, maxTokens, timeoutMs }
   *
   * @returns {Promise<object>}  Standardized response
   */
  async run(task, params = {}) {
    const {
      text,
      prompt,
      file,
      formFile,
      dataSourceFile,
      targetLanguage,
      analysisType,
      history,
      options = {},
      // New feature params
      filename,
      explainMode,
      quizType,
      quizCount,
      summaryMode,
      // Quiz v2 params
      questionType,
      quizDifficulty,
      weakTopics,
      retrievedContext,
    } = params;

    // Ensure providers are ready
    aiProvider.initialize();

    const startTime = Date.now();

    try {
      let result;

      switch (task) {
        case "summarize":
          result = await this._summarize(
            text,
            file,
            options,
            params.summaryMode,
          );
          break;
        case "translate":
          result = await this._translate(text, file, targetLanguage, options);
          break;
        case "analyze":
          result = await this._analyze(text, file, analysisType, options);
          break;
        case "tasks":
        case "extract-tasks":
          result = await this._extractTasks(text, file, options);
          break;
        case "fill-form":
          result = await this._fillForm(
            formFile,
            dataSourceFile,
            text,
            options,
          );
          break;
        case "chat":
          result = await this._chat(text, file, prompt, history, options);
          break;
        case "classify":
          result = await this._classify(text, file, filename, options);
          break;
        case "highlight":
          result = await this._highlight(text, file, options);
          break;
        case "explain":
          result = await this._explain(text, explainMode, options, params.explainDepth);
          break;
        case "generate-document":
          result = await this._generateDocument(
            prompt,
            params.fileType,
            params.category,
            params.tone,
            params.wordCount,
            params.audience,
            options,
          );
          break;
        case "quiz":
          result = await this._quiz(
            text,
            file,
            questionType || quizType,
            quizCount,
            options,
            quizDifficulty,
            weakTopics,
            retrievedContext,
          );
          break;
        default: {
          const err = new Error(`Unknown AI task: "${task}"`);
          err.code = "VALIDATION_ERROR";
          throw err;
        }
      }

      const elapsed = Date.now() - startTime;
      logger.info(
        `AI task "${task}" completed in ${elapsed}ms via ${result.provider}`,
      );

      return this._formatSuccess(task, result);
    } catch (err) {
      const elapsed = Date.now() - startTime;
      logger.error(`AI task "${task}" failed after ${elapsed}ms`, {
        error: err.message,
        code: err.code,
      });
      throw err;
    }
  }

  // ─── Individual task implementations ───────────────────────────

  async _summarize(text, file, options, summaryMode) {
    const docText = await this._resolveDocumentText(text, file);
    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    return mapReduceLong({
      text: safeText,
      chatOptions: options,
      buildMapMessages: (chunk, i) => [
        { role: "system", content: PROMPT_TEMPLATES.summarize.system },
        {
          role: "user",
          content:
            `You are summarizing PART ${i + 1} of a longer document. ` +
            `Produce a partial summary covering ONLY this part — do not invent ` +
            `content from sections you cannot see.\n\n` +
            PROMPT_TEMPLATES.summarize.userPrompt(chunk, summaryMode),
        },
      ],
      buildReduceMessages: (parts) => [
        { role: "system", content: PROMPT_TEMPLATES.summarize.system },
        {
          role: "user",
          content:
            `Below are partial summaries of consecutive sections of a long document. ` +
            `Merge them into ONE final ${summaryMode || "detailed"} summary that reads as a single coherent piece. ` +
            `Remove redundancy. Preserve every distinct fact, finding, or recommendation.\n\n` +
            parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join("\n\n"),
        },
      ],
    });
  }

  async _translate(text, file, targetLanguage, options) {
    if (!targetLanguage) {
      const err = new Error("Target language is required for translation");
      err.code = "VALIDATION_ERROR";
      throw err;
    }

    const docText = await this._resolveDocumentText(text, file);
    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    const systemContent =
      typeof PROMPT_TEMPLATES.translate.system === "function"
        ? PROMPT_TEMPLATES.translate.system(targetLanguage)
        : PROMPT_TEMPLATES.translate.system;

    const messages = [
      { role: "system", content: systemContent },
      {
        role: "user",
        content: PROMPT_TEMPLATES.translate.userPrompt(safeText),
      },
    ];

    return aiProvider.chat(messages, options);
  }

  async _analyze(text, file, analysisType, options) {
    const docText = await this._resolveDocumentText(text, file);
    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    const result = await mapReduceLong({
      text: safeText,
      chatOptions: options,
      buildMapMessages: (chunk, i) => [
        { role: "system", content: PROMPT_TEMPLATES.analyze.system },
        {
          role: "user",
          content:
            `Analyze PART ${i + 1} of a longer document. Focus only on this part. ` +
            `Return the same JSON shape requested below.\n\n` +
            PROMPT_TEMPLATES.analyze.userPrompt(chunk, analysisType),
        },
      ],
      buildReduceMessages: (parts) => [
        { role: "system", content: PROMPT_TEMPLATES.analyze.system },
        {
          role: "user",
          content:
            `Below are JSON analyses of consecutive parts of a long document. ` +
            `Merge them into ONE final JSON object using the SAME schema (summary, sentiment, sentimentScore, ` +
            `insights, strengths, weaknesses, recommendations, topics, readability). ` +
            `Deduplicate, keep the most useful items, and average the sentimentScore. ` +
            `Return ONLY the merged JSON.\n\n` +
            parts.map((p, i) => `--- Part ${i + 1} JSON ---\n${p}`).join("\n\n"),
        },
      ],
    });

    // Parse JSON response
    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : result.content;
      result.json = JSON.parse(raw);
    } catch {
      // Non-JSON response is still useful as text
    }

    return result;
  }

  async _extractTasks(text, file, options) {
    const docText = await this._resolveDocumentText(text, file);
    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    const result = await mapReduceLong({
      text: safeText,
      chatOptions: options,
      buildMapMessages: (chunk, i) => [
        { role: "system", content: PROMPT_TEMPLATES.tasks.system },
        {
          role: "user",
          content:
            `Extract action items from PART ${i + 1} of a longer document only. ` +
            `Do not invent tasks not in this part.\n\n` +
            PROMPT_TEMPLATES.tasks.userPrompt(chunk),
        },
      ],
      buildReduceMessages: (parts) => [
        { role: "system", content: PROMPT_TEMPLATES.tasks.system },
        {
          role: "user",
          content:
            `Below are JSON task lists from consecutive parts of one document. ` +
            `Merge into ONE final {"tasks":[...]} JSON. Drop duplicates (same action ` +
            `+ owner). Preserve all unique tasks. Re-number ids "task-1"..."task-N". ` +
            `Return ONLY valid JSON, no markdown.\n\n` +
            parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join("\n\n"),
        },
      ],
    });

    // Strip markdown code fences if present, then parse JSON
    try {
      const fenceMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/s);
      const raw = fenceMatch ? fenceMatch[1].trim() : result.content.trim();
      // Find outermost JSON object in case the model added surrounding text
      const objStart = raw.indexOf("{");
      const objEnd = raw.lastIndexOf("}");
      const jsonStr = objStart !== -1 && objEnd > objStart ? raw.slice(objStart, objEnd + 1) : raw;
      const parsed = JSON.parse(jsonStr);
      if (parsed && Array.isArray(parsed.tasks)) {
        // Normalize each task to ensure required fields exist
        parsed.tasks = parsed.tasks.map((t, i) => ({
          id: t.id || `task-${i + 1}`,
          action: t.action || t.title || "Untitled task",
          owner: t.owner || "Unassigned",
          deadline: (t.deadline && t.deadline !== "Not specified" && t.deadline !== "Unspecified") ? t.deadline : "",
          priority: ["urgent", "high", "medium", "low"].includes(t.priority) ? t.priority : "medium",
          context: t.context || "",
          category: t.category || "other",
        }));
        result.json = parsed;
        result.tasks = parsed.tasks;
        return result;
      }
    } catch {
      // Fall through to line-parse fallback
    }

    // Fallback: convert text lines to minimal task objects so the renderer
    // always receives structured data rather than raw strings.
    const taskLines = result.content
      .split("\n")
      .filter((line) => line.trim().length > 10)
      .map((line, i) => ({
        id: `task-${i + 1}`,
        action: line.replace(/^\d+[.)]\s*/, "").replace(/^[-*•]\s*/, "").trim(),
        owner: "Unassigned",
        deadline: "",
        priority: "medium",
        context: "",
        category: "other",
      }))
      .filter((t) => t.action.length > 0);

    result.json = { tasks: taskLines };
    result.tasks = taskLines;
    return result;
  }

  async _fillForm(formFile, dataSourceFile, text, options) {
    let formText = "";
    let dataText = text || "";

    if (formFile) {
      formText = await documentProcessor.extractText(formFile);
    }
    if (dataSourceFile) {
      dataText = await documentProcessor.extractText(dataSourceFile);
    }

    if (!formText && !dataText) {
      const err = new Error("Form file or data text is required");
      err.code = "VALIDATION_ERROR";
      throw err;
    }

    const half = Math.floor(aiConfig.maxDocumentLength / 2);
    const { text: safeForm } = documentProcessor.truncate(formText, half);
    const { text: safeData } = documentProcessor.truncate(dataText, half);

    const messages = [
      { role: "system", content: PROMPT_TEMPLATES["fill-form"].system },
      {
        role: "user",
        content: PROMPT_TEMPLATES["fill-form"].userPrompt(safeForm, safeData),
      },
    ];

    const result = await aiProvider.chat(messages, options);

    // Attempt to parse JSON from the response
    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        result.json = JSON.parse(jsonMatch[1].trim());
      } else {
        result.json = JSON.parse(result.content);
      }
    } catch {
      // Response isn't valid JSON — text output is still useful
    }

    return result;
  }

  async _chat(text, file, prompt, history, options) {
    if (!prompt) {
      const err = new Error("Message/prompt is required for chat");
      err.code = "VALIDATION_ERROR";
      throw err;
    }

    let documentContext = text || "";
    if (file) {
      documentContext = await documentProcessor.extractText(file);
    }

    const { text: safeDoc } = documentProcessor.truncate(
      documentContext,
      aiConfig.maxDocumentLength,
    );

    const systemContent = PROMPT_TEMPLATES.chat.system(safeDoc || null);
    const messages = [{ role: "system", content: systemContent }];

    // Add conversation history
    if (history && Array.isArray(history)) {
      for (const msg of history) {
        if (msg.role && msg.content) {
          messages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: msg.content,
          });
        }
      }
    }

    // Add current user message
    messages.push({ role: "user", content: prompt });

    return aiProvider.chat(messages, options);
  }

  async _classify(text, file, filename, options) {
    const docText = await this._resolveDocumentText(text, file);
    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    const messages = [
      { role: "system", content: PROMPT_TEMPLATES.classify.system },
      {
        role: "user",
        content: PROMPT_TEMPLATES.classify.userPrompt(safeText, filename),
      },
    ];

    const result = await aiProvider.chat(messages, options);

    // Parse JSON response
    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : result.content;
      result.json = JSON.parse(raw);
    } catch {
      // Non-JSON response is still useful as text
    }

    return result;
  }

  async _highlight(text, file, options) {
    const docText = await this._resolveDocumentText(text, file);
    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    // ── Step 1: Quick document classification to tailor categories ──────────
    let documentType = "other";
    try {
      documentType = await this._classifyQuick(safeText, options);
    } catch (err) {
      logger.warn("highlight: quick classify failed, using defaults", {
        error: err.message,
      });
    }

    const allowedCategories =
      CATEGORY_PROFILES[documentType] || DEFAULT_CATEGORIES;

    // ── Step 2: Highlight extraction (chunked for long documents) ──────────
    const result = await mapReduceLong({
      text: safeText,
      chatOptions: options,
      buildMapMessages: (chunk, i) => [
        { role: "system", content: PROMPT_TEMPLATES.highlight.system },
        {
          role: "user",
          content:
            `Extract highlights from PART ${i + 1} of a longer document. ` +
            `Only quote text that appears in this part — NEVER fabricate.\n\n` +
            PROMPT_TEMPLATES.highlight.userPrompt(chunk, documentType, allowedCategories),
        },
      ],
      // For the reduce step, the LLM merges per-chunk highlight arrays into
      // one master JSON. We keep the same schema.
      buildReduceMessages: (parts) => [
        { role: "system", content: PROMPT_TEMPLATES.highlight.system },
        {
          role: "user",
          content:
            `You will receive highlight JSON arrays extracted from consecutive parts of a long ` +
            `document. Merge them into ONE final JSON object with the SAME schema ` +
            `(highlights[] and meta{summary, keyThemes, documentType}). ` +
            `Keep the 10–15 MOST important highlights overall — drop duplicates and ` +
            `near-duplicates, preserve verbatim quotes exactly. Return ONLY valid JSON.\n\n` +
            parts.map((p, i) => `--- Part ${i + 1} JSON ---\n${p}`).join("\n\n"),
        },
      ],
    });

    // Parse JSON response
    let parsed = null;
    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : result.content;
      parsed = JSON.parse(raw);
    } catch {
      // Non-JSON response is still useful as text
    }

    // ── Step 3: Normalize + enrich with SourceMapper ────────────────────────
    if (parsed && Array.isArray(parsed.highlights)) {
      const normalized = parsed.highlights.map((h) => ({
        text: String(h.text || "").trim(),
        importance: ["critical", "high", "medium"].includes(h.importance)
          ? h.importance
          : "medium",
        category: h.category || "key_finding",
        reason: String(h.reason || "").trim(),
        confidence: clampConfidence(h.confidence),
        sourceReference:
          h.sourceReference && typeof h.sourceReference === "object"
            ? h.sourceReference
            : undefined,
      }));

      const { highlights: enriched, pageDensity } = enrichHighlights(
        normalized,
        safeText,
      );

      const meta = parsed.meta && typeof parsed.meta === "object" ? { ...parsed.meta } : {};
      if (!meta.documentType) meta.documentType = documentType;
      meta.pageDensity = pageDensity;

      result.json = { highlights: enriched, meta };
    }

    return result;
  }

  async _classifyQuick(text, options) {
    const { text: safeText } = documentProcessor.truncate(text, 4000);
    const messages = [
      { role: "system", content: PROMPT_TEMPLATES.classify.system },
      {
        role: "user",
        content: PROMPT_TEMPLATES.classify.userPrompt(safeText, null),
      },
    ];
    const result = await aiProvider.chat(messages, {
      ...options,
      maxTokens: 200,
    });
    try {
      const match = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = match ? match[1].trim() : result.content;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.type === "string") return parsed.type;
    } catch {
      // ignore
    }
    return "other";
  }

  async _highlightSummary(highlights, documentName, options) {
    if (!Array.isArray(highlights) || highlights.length === 0) {
      return {
        provider: aiProvider.currentProvider,
        content: "",
        json: { summary: [], keyThemes: [] },
      };
    }

    const messages = [
      { role: "system", content: PROMPT_TEMPLATES["highlight-summary"].system },
      {
        role: "user",
        content: PROMPT_TEMPLATES["highlight-summary"].userPrompt(
          highlights,
          documentName,
        ),
      },
    ];

    const result = await aiProvider.chat(messages, options);

    try {
      const match = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = match ? match[1].trim() : result.content;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        result.json = {
          summary: Array.isArray(parsed.summary) ? parsed.summary : [],
          keyThemes: Array.isArray(parsed.keyThemes) ? parsed.keyThemes : [],
        };
      }
    } catch {
      // Non-JSON fallback: split content into bullet lines
      const lines = String(result.content || "")
        .split(/\r?\n/)
        .map((l) => l.replace(/^[-*•\d.\s]+/, "").trim())
        .filter(Boolean);
      result.json = { summary: lines.slice(0, 5), keyThemes: [] };
    }

    return result;
  }

  async _explain(text, mode, options, depth) {
    if (!text) {
      const err = new Error("Text is required for explanation");
      err.code = "VALIDATION_ERROR";
      throw err;
    }

    const { text: safeText } = documentProcessor.truncate(
      text,
      aiConfig.maxDocumentLength,
    );

    const systemContent =
      typeof PROMPT_TEMPLATES.explain.system === "function"
        ? PROMPT_TEMPLATES.explain.system(mode)
        : PROMPT_TEMPLATES.explain.system;

    return mapReduceLong({
      text: safeText,
      chatOptions: options,
      buildMapMessages: (chunk, i) => [
        { role: "system", content: systemContent },
        {
          role: "user",
          content:
            `Explain PART ${i + 1} of a longer text in the same style.\n\n` +
            PROMPT_TEMPLATES.explain.userPrompt(chunk, mode, depth),
        },
      ],
      buildReduceMessages: (parts) => [
        { role: "system", content: systemContent },
        {
          role: "user",
          content:
            `Combine these per-part explanations into ONE smooth explanation in the ` +
            `same tone and depth. Remove redundancy, preserve every distinct point.\n\n` +
            parts.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join("\n\n"),
        },
      ],
    });
  }

  async _quiz(text, file, questionType, count, options, difficulty, weakTopics, retrievedContext) {
    // Retrieved context (from stored docId chunks) takes precedence; otherwise use raw text.
    const docText = retrievedContext && retrievedContext.length > 0
      ? retrievedContext
      : await this._resolveDocumentText(text, file);

    // Only refuse up-front when there's effectively NO text at all.
    // Any document with real content should be allowed to attempt generation — the
    // grounding guarantee comes from prompt + post-validation, not a char threshold.
    const plain = stripAnchors(docText).replace(/\s+/g, " ").trim();
    if (plain.length < 40) {
      logger.warn(
        `[quiz] short-circuit: document has only ${plain.length} chars of extractable text ` +
          `(source=${retrievedContext ? "retrieval" : "text/file"}). ` +
          `Likely a scanned (image-only) PDF without OCR, or text extraction returned empty.`,
        { preview: plain.slice(0, 120) },
      );
      return {
        provider: aiProvider.currentProvider,
        content: "",
        json: {
          questions: [],
          insufficient: true,
          reason:
            "No readable text was found in this document. " +
            "If it's a scanned or image-based PDF, text extraction requires OCR which is not currently available. " +
            "Try uploading a text-based PDF, DOCX, or PPTX file instead.",
        },
      };
    }

    const { text: safeText } = documentProcessor.truncate(
      docText,
      aiConfig.maxDocumentLength,
    );

    const messages = [
      { role: "system", content: PROMPT_TEMPLATES.quiz.system },
      {
        role: "user",
        content: PROMPT_TEMPLATES.quiz.userPrompt(safeText, questionType, count, difficulty, weakTopics),
      },
    ];

    // Low temperature — we want retrieval-faithful output, not creative writing.
    const result = await aiProvider.chat(messages, {
      ...options,
      temperature: (options && typeof options.temperature === "number") ? options.temperature : 0.1,
    });

    let parsed = null;
    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : result.content;
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn("[quiz] LLM did not return valid JSON", { preview: String(result.content || "").slice(0, 200) });
    }

    const requested = Math.min(Math.max(parseInt(count) || 5, 3), 20);
    const validated = validateQuizQuestions(parsed, safeText, requested);
    result.json = validated;
    return result;
  }

  async _generateDocument(prompt, fileType, category, tone, wordCount, audience, options) {
    if (!prompt) {
      const err = new Error("Prompt is required for document generation");
      err.code = "VALIDATION_ERROR";
      throw err;
    }

    const systemContent = PROMPT_TEMPLATES["generate-document"].system(tone, audience, fileType);
    const messages = [
      { role: "system", content: systemContent },
      {
        role: "user",
        content: PROMPT_TEMPLATES["generate-document"].userPrompt(prompt, category, wordCount, fileType),
      },
    ];

    return aiProvider.chat(messages, options);
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * Run highlight summary on a pre-extracted highlights list.
   * Exposed for the /highlight-summary route.
   */
  async summarizeHighlights({ highlights, documentName, options }) {
    const result = await this._highlightSummary(highlights, documentName, options);
    return this._formatSuccess("highlight-summary", result);
  }

  /**
   * Resolve document text from either raw text or a file upload.
   */
  async _resolveDocumentText(text, file) {
    if (text && text.length > 0) return text;
    if (file) return documentProcessor.extractText(file);
    const err = new Error("No document text or file provided");
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  /**
   * Format a successful AI result into the stable response shape.
   */
  _formatSuccess(task, result) {
    return {
      success: true,
      provider: result.provider || aiProvider.currentProvider,
      task,
      data: {
        text: result.content,
        json: result.json || null,
        tasks: result.tasks || null,
        usage: result.usage || null,
      },
    };
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 75; // reasonable default if model didn't return one
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

// ─── Quiz grounding utilities ────────────────────────────────────────────────

function stripAnchors(text) {
  if (!text) return "";
  return String(text)
    .replace(/\[Page \d+\]/g, " ")
    .replace(/\[Slide \d+\]/g, " ")
    .replace(/\[Sheet [^\]]+\]/g, " ");
}

function fuzzyContains(haystack, needle) {
  if (!haystack || !needle) return false;
  const hay = normalize(haystack);
  const nd = normalize(needle);
  if (!nd) return false;
  if (hay.includes(nd)) return true;
  // Short needles — accept if the substring appears after basic normalization
  if (nd.length < 8) return false;
  // Token-overlap fallback (tolerates minor differences from OCR / line breaks)
  const tokens = nd.split(" ").filter((w) => w.length > 3);
  if (tokens.length === 0) {
    // Fall back to char-level overlap for token-less phrases
    return hay.includes(nd.slice(0, Math.max(6, Math.floor(nd.length * 0.7))));
  }
  const hits = tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
  // 55% token overlap: the LLM is instructed to copy verbatim but minor OCR/whitespace
  // differences can cause ~1-in-3 tokens to diverge. 55% still requires a clear majority match.
  return hits / tokens.length >= 0.55;
}

/**
 * Validate LLM quiz output against the document context.
 * - Drops any question whose `source_text` is not actually in the document.
 * - Drops MCQ whose correct `answer` is missing from its source_text.
 * - Enriches each question's `source_reference` with page/section from the document.
 * - Returns an `insufficient` payload when too few questions survive validation.
 */
function validateQuizQuestions(parsed, docText, requestedCount) {
  // Be permissive: as long as at least one grounded question survives, return it.
  // Only when zero grounded questions remain do we emit the insufficient-content signal.
  const minKeep = 1;

  if (!parsed || typeof parsed !== "object") {
    return {
      questions: [],
      insufficient: true,
      reason: "This document does not contain enough clear information to generate a full quiz. Try a different file or reduce quiz length.",
    };
  }

  if (parsed.insufficient === true) {
    return {
      questions: [],
      insufficient: true,
      reason: parsed.reason || "This document does not contain enough clear information to generate a full quiz. Try a different file or reduce quiz length.",
    };
  }

  const rawQs = Array.isArray(parsed.questions) ? parsed.questions : [];
  const plainDoc = stripAnchors(docText);
  const validated = [];
  const dropped = [];

  for (const q of rawQs) {
    if (!q || typeof q !== "object") continue;

    const sourceText = typeof q.source_text === "string" ? q.source_text.trim() : "";
    const questionText = typeof q.question === "string" ? q.question.trim() : "";
    const answer = typeof q.answer === "string" ? q.answer.trim() : "";

    if (!questionText || !answer || !sourceText) {
      dropped.push({ q: questionText.slice(0, 60), reason: "missing required fields" });
      continue;
    }

    // Source text MUST appear in the document.
    if (!fuzzyContains(plainDoc, sourceText)) {
      dropped.push({ q: questionText.slice(0, 60), reason: "source_text not in document" });
      continue;
    }

    // MCQ: correct answer must be present in the source_text (prevents LLM from
    // inventing a correct option that isn't actually supported).
    const type = q.type === "mcq" || q.type === "true_false" || q.type === "short"
      ? q.type
      : (Array.isArray(q.options) && q.options.length >= 3 ? "mcq" : "short");

    if (type === "mcq") {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        dropped.push({ q: questionText.slice(0, 60), reason: "mcq missing options" });
        continue;
      }
      if (!q.options.includes(answer)) {
        dropped.push({ q: questionText.slice(0, 60), reason: "answer not among options" });
        continue;
      }
      if (!fuzzyContains(sourceText, answer) && !fuzzyContains(plainDoc, answer)) {
        dropped.push({ q: questionText.slice(0, 60), reason: "mcq answer not in document" });
        continue;
      }
    } else if (type === "true_false") {
      if (answer !== "True" && answer !== "False" && answer !== "true" && answer !== "false") {
        dropped.push({ q: questionText.slice(0, 60), reason: "invalid true_false answer" });
        continue;
      }
    }

    // Enrich source_reference with page/section from the actual document.
    const located = locateSnippet(docText, sourceText);
    const refIn = q.source_reference && typeof q.source_reference === "object" ? q.source_reference : {};
    const sourceReference = {
      ...refIn,
      ...located,
    };
    if (!sourceReference.snippet) {
      sourceReference.snippet = sourceText.slice(0, 80);
    }

    validated.push({
      id: q.id || `q${validated.length + 1}`,
      type,
      question: questionText,
      options: type === "mcq" ? q.options.slice(0, 4) : undefined,
      answer: type === "true_false"
        ? (answer.toLowerCase() === "true" ? "True" : "False")
        : answer,
      explanation: typeof q.explanation === "string" ? q.explanation : "",
      source_text: sourceText,
      source_reference: sourceReference,
      difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
      topic: typeof q.topic === "string" && q.topic.trim() ? q.topic.trim() : "General",
    });
  }

  if (dropped.length > 0) {
    logger.info(`[quiz] dropped ${dropped.length}/${rawQs.length} ungrounded questions`, { dropped: dropped.slice(0, 5) });
  }

  if (validated.length < minKeep) {
    return {
      questions: validated,
      insufficient: true,
      reason: "This document does not contain enough clear information to generate a full quiz. Try a different file or reduce quiz length.",
      requestedCount,
      validCount: validated.length,
    };
  }

  return {
    questions: validated,
    insufficient: false,
    requestedCount,
    validCount: validated.length,
  };
}

/**
 * Build a retrieval context from a stored document's chunks. Samples diverse
 * chunks (first, evenly-spaced middles, last, and any chunk mentioning weak
 * topics) up to a character budget to feed the LLM grounded material.
 */
function buildRetrievalContext(doc, { weakTopics = [], budgetChars = 12000 } = {}) {
  if (!doc) return "";

  // Prefer pre-built chunks; otherwise synthesize chunks from stored pages so
  // tiny documents (1-page PDFs, short DOCX) still produce retrieval context.
  let chunks = Array.isArray(doc.chunks) ? doc.chunks : [];
  if (chunks.length === 0 && Array.isArray(doc.pages) && doc.pages.length > 0) {
    chunks = doc.pages
      .filter((p) => p && typeof p.text === "string" && p.text.trim().length > 0)
      .map((p, idx) => ({
        chunkId: idx,
        text: `[Page ${p.page ?? idx + 1}]\n${p.text.trim()}`,
        pages: [p.page ?? idx + 1],
      }));
  }
  if (chunks.length === 0) return "";
  const picked = new Set();
  const order = [];

  const take = (idx) => {
    if (idx < 0 || idx >= chunks.length) return;
    if (picked.has(idx)) return;
    picked.add(idx);
    order.push(idx);
  };

  // Weak-topic chunks first
  if (weakTopics && weakTopics.length > 0) {
    const needles = weakTopics
      .map((t) => String(t || "").toLowerCase())
      .filter((t) => t.length > 2);
    for (let i = 0; i < chunks.length && picked.size < 8; i++) {
      const hay = (chunks[i].text || "").toLowerCase();
      if (needles.some((n) => hay.includes(n))) take(i);
    }
  }

  // Always include first chunk (usually intro/title)
  take(0);

  // Evenly spaced samples across the document
  const samples = Math.min(6, chunks.length);
  for (let s = 1; s < samples - 1; s++) {
    const idx = Math.floor((s * chunks.length) / samples);
    take(idx);
  }

  // Always include last chunk (usually conclusion)
  take(chunks.length - 1);

  // Fill remaining budget with whatever's left, in document order
  for (let i = 0; i < chunks.length; i++) take(i);

  order.sort((a, b) => a - b);
  let out = "";
  for (const idx of order) {
    const c = chunks[idx];
    if (!c || !c.text) continue;
    const block = c.text.trim();
    if (out.length + block.length + 2 > budgetChars) break;
    out += (out ? "\n\n" : "") + block;
  }
  return out;
}

const service = new AIService();
service.buildRetrievalContext = buildRetrievalContext;
module.exports = service;
