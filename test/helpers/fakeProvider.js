/**
 * Fake AI provider for tests. No network, no real model calls.
 *
 * Installed directly into the aiProvider singleton so every service that calls
 * aiProvider.chat()/chatStream() goes through it.
 */

const aiProvider = require("../../src/services/aiProvider");

class FakeProvider {
  constructor(opts = {}) {
    this.name = opts.name || "fake";
    this.calls = [];
    this.responder = opts.responder || defaultResponder;
    this.streamChunks = opts.streamChunks || null;
    this.aborted = false;
  }

  async chat(messages, options = {}) {
    this.calls.push({ messages, options });
    const content = await this.responder(messages, options, this);
    if (content instanceof Error) throw content;
    return {
      content,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      provider: this.name,
      stopReason: "end_turn",
    };
  }

  async chatStream(messages, options = {}, { signal, onText } = {}) {
    this.calls.push({ messages, options, stream: true });
    const full = await this.responder(messages, options, this);
    if (full instanceof Error) throw full;

    const pieces = this.streamChunks || splitForStream(full);
    let sent = "";
    for (const piece of pieces) {
      if (signal && signal.aborted) {
        this.aborted = true;
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      sent += piece;
      if (onText) onText(piece);
      await new Promise((r) => setImmediate(r));
    }

    return {
      content: sent,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      provider: this.name,
      stopReason: "end_turn",
    };
  }
}

function splitForStream(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 7) out.push(text.slice(i, i + 7));
  return out;
}

/**
 * Default responder — returns output that satisfies each task's parser so the
 * shape of a successful response can be snapshotted.
 */
function defaultResponder(messages) {
  const user = String(messages[messages.length - 1]?.content || "");
  const system = String(messages.find((m) => m.role === "system")?.content || "");

  // classify (also used by /highlight's quick-classify step)
  if (user.includes('"suggestedFilename"')) {
    return JSON.stringify({
      type: "report",
      confidence: 90,
      suggestedFilename: "Test_Report.pdf",
      summary: "A test report.",
      keyEntities: ["Acme"],
    });
  }

  if (user.includes('"sentimentScore"')) {
    return JSON.stringify({
      summary: "A short analysis.",
      sentiment: "neutral",
      sentimentScore: 0,
      insights: [{ title: "Insight", detail: "Detail here." }],
      strengths: ["Clear"],
      weaknesses: ["Short"],
      recommendations: ["Expand"],
      topics: ["testing"],
      readability: { level: "easy", notes: "Plain language." },
    });
  }

  if (user.includes('"tasks"') || system.includes("action items")) {
    return JSON.stringify({
      tasks: [
        {
          id: "task-1",
          action: "Review the report",
          owner: "Alice",
          deadline: "Friday",
          priority: "high",
          context: "Mentioned in the document.",
          category: "review",
        },
      ],
    });
  }

  if (user.includes('"highlights"') || system.includes("critical information")) {
    return JSON.stringify({
      highlights: [
        {
          text: "Revenue grew by 15 percent.",
          importance: "critical",
          category: "financial",
          reason: "Signals growth that drives budget decisions.",
          confidence: 90,
          sourceReference: { snippet: "Revenue grew by 15 percent" },
        },
      ],
      meta: {
        summary: ["Growth is strong."],
        keyThemes: ["growth"],
        documentType: "report",
      },
    });
  }

  if (user.includes('"questions"') || system.includes("assessment generator")) {
    return JSON.stringify({
      questions: [
        {
          id: "q1",
          type: "short",
          question: "What grew by 15 percent?",
          answer: "Revenue.",
          explanation: "The document states revenue grew.",
          source_text: "Revenue grew by 15 percent.",
          source_reference: { snippet: "Revenue grew by 15 percent" },
          difficulty: "easy",
          topic: "Financials",
        },
      ],
    });
  }

  if (user.includes('"killerObjections"')) {
    return JSON.stringify({
      detectedRole: "Skeptical Investor",
      roleKey: "investor",
      documentType: "Pitch Deck",
      killerObjections: [
        { title: "No moat", detail: "Competitors can copy this.", severity: "critical", reference: "Slide 3" },
        { title: "Unit economics", detail: "CAC exceeds LTV.", severity: "high", reference: "" },
        { title: "Team gap", detail: "No technical founder.", severity: "high", reference: "" },
      ],
      secondaryChallenges: [
        { title: "Pricing", detail: "Pricing is untested.", severity: "medium" },
        { title: "Timeline", detail: "Roadmap is aggressive.", severity: "medium" },
        { title: "Churn", detail: "Retention unproven.", severity: "medium" },
      ],
      blindSpots: [
        { text: "Regulatory risk", why: "Not addressed anywhere." },
        { text: "Support costs", why: "Omitted from the model." },
      ],
    });
  }

  if (user.includes('"verdictLine"')) {
    return JSON.stringify({
      verdict: "weak",
      verdictLine: "The ask arrives before the proof.",
      detectedType: "Business Proposal",
      diagnosis: "Evidence is buried at the end.",
      idealStructure: ["Problem", "Solution", "Proof", "Ask"],
      detectedSections: [
        { title: "Ask", index: 1, role: "request", status: "misplaced" },
        { title: "Problem", index: 2, role: "setup", status: "ok" },
      ],
      reorder: [{ instruction: "Move the ask to the end", from: 1, to: 2 }],
    });
  }

  // Chat-with-document answers carry a citations block.
  if (system.includes("<citations>")) {
    return 'Revenue grew by 15 percent. [1]\n<citations>{"found": true, "citations": [{"id": 1, "chunk": 0, "quote": "Revenue grew by 15 percent."}]}</citations>';
  }

  if (system.includes("answers questions about a PDF") || system.includes("document assistant")) {
    return JSON.stringify({
      answer: "Revenue grew by 15 percent (Page 1).",
      citations: [{ page: 1, quote: "Revenue grew by 15 percent." }],
      found: true,
    });
  }

  return "This is a fake model response for testing purposes.";
}

/**
 * Install the fake as the active provider. Returns the fake.
 */
function installFakeProvider(opts = {}) {
  const fake = new FakeProvider(opts);
  aiProvider.initialize();
  aiProvider.providers.set(fake.name, fake);
  aiProvider._realProvider = aiProvider.currentProvider;
  aiProvider.currentProvider = fake.name;
  aiProvider.enableFallback = false;
  aiProvider._initialized = true;
  return fake;
}

function restoreProvider() {
  if (aiProvider._realProvider) {
    aiProvider.currentProvider = aiProvider._realProvider;
    delete aiProvider._realProvider;
  }
  aiProvider.providers.delete("fake");
}

module.exports = { FakeProvider, installFakeProvider, restoreProvider, defaultResponder };
