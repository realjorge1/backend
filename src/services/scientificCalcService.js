/**
 * Scientific Calculator AI Service
 * Powered by Claude (claude-sonnet-4-20250514)
 */

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are an elite scientific calculator and converter — a PhD-level expert across all scientific disciplines including medicine, pharmacology, biochemistry, organic/inorganic chemistry, physics (classical, quantum, relativistic), biology, genetics, astronomy, engineering, and mathematics.

Your task is to solve any scientific calculation, unit conversion, formula application, or equation the user provides. You always return a structured JSON object.

RESPONSE FORMAT — always return ONLY valid JSON, no markdown fences, no preamble:
{
  "category": "one of: Medical | Chemistry | Physics | Biology | Mathematics | Astronomy | Engineering | Conversions | Other",
  "title": "Short descriptive title for this calculation",
  "result": {
    "value": "The numerical or textual result",
    "unit": "Unit of the result (if applicable)",
    "formatted": "Human-readable result with unit e.g. '9.81 m/s²'"
  },
  "formula": {
    "expression": "The formula/equation used e.g. 'F = ma'",
    "variables": [
      { "symbol": "F", "name": "Force", "value": "20", "unit": "N" }
    ]
  },
  "steps": [
    "Step 1: Identify known variables...",
    "Step 2: Apply the formula...",
    "Step 3: Substitute values...",
    "Step 4: Calculate result..."
  ],
  "explanation": "Clear 2-3 sentence explanation of what was calculated and what the result means in context.",
  "related": ["List", "of", "related", "formulas", "or", "calculations"],
  "references": ["Standard reference e.g. 'NIST Physics Constants 2024'"],
  "warnings": ["Any important clinical/safety notes if medical, or precision notes"],
  "confidence": "high | medium | low",
  "updated_knowledge": null
}

RULES:
- Always use the most current scientific constants (CODATA 2022, NIST 2024, latest pharmacological guidelines).
- For medical calculations, always include appropriate clinical warnings.
- For chemistry, include state symbols and conditions where relevant.
- For unit conversions, show the conversion factor used.
- If a query is ambiguous, make a reasonable scientific assumption and state it in the steps.
- Never refuse a legitimate scientific query. Always attempt to solve it.
- For complex equations, break down steps clearly enough for a graduate student to follow.
- If multiple valid interpretations exist, solve using SI units by default and mention alternatives.`;

async function calculate(query, category = null, variables = {}) {
  let userMessage = query;

  if (category) {
    userMessage = `[Category hint: ${category}]\n\n${query}`;
  }

  if (variables && Object.keys(variables).length > 0) {
    const varStr = Object.entries(variables)
      .map(([k, v]) => `${k} = ${v}`)
      .join(", ");
    userMessage += `\n\nGiven variables: ${varStr}`;
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const rawText = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const cleaned = rawText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  parsed._meta = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    model: response.model,
    timestamp: new Date().toISOString(),
  };

  return parsed;
}

async function getSuggestions(category) {
  const prompt = `Return a JSON array of 8 example scientific calculation queries for the category: "${category}".
Make them realistic, varied in complexity, and practical.
Return ONLY the JSON array, no other text.
Example format: ["Calculate BMI for 75kg, 1.75m", "Convert 98.6°F to Celsius", ...]`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  return JSON.parse(text);
}

module.exports = { calculate, getSuggestions };
