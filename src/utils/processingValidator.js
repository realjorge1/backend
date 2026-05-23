/**
 * Processing Validation Utility
 *
 * Ensures PDF tools actually modify files before returning success.
 * Compares input vs output to detect fake/no-op processing.
 */

const crypto = require("crypto");

/**
 * Compute SHA-256 hash of a Buffer.
 */
function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Validate that output differs from input.
 *
 * @param {Buffer} inputBytes  - Original file bytes
 * @param {Buffer} outputBytes - Processed file bytes
 * @param {string} toolName    - Tool name for error messages
 * @throws {Error} If output is identical to input
 */
function validateOutputChanged(inputBytes, outputBytes, toolName) {
  const inputHash = hashBuffer(inputBytes);
  const outputHash = hashBuffer(outputBytes);

  if (inputHash === outputHash) {
    throw new Error(
      `Processing failed: ${toolName} produced no changes. ` +
        `Input and output are identical (hash: ${inputHash.substring(0, 12)}...). ` +
        `No modifications were applied to the document.`,
    );
  }

  return {
    inputHash,
    outputHash,
    inputSize: inputBytes.length,
    outputSize: outputBytes.length,
    sizeDelta: outputBytes.length - inputBytes.length,
  };
}

/**
 * Validate that extracted text does NOT contain redacted terms.
 * Used for post-redaction verification.
 *
 * @param {Function} extractFn  - Async function that returns extracted text
 * @param {string[]} terms      - Terms that should have been removed
 * @param {boolean} caseSensitive
 * @returns {Promise<{verified: boolean, leaks: string[]}>}
 */
async function verifyRedaction(extractFn, terms, caseSensitive = false) {
  const text = await extractFn();
  const leaks = [];

  for (const term of terms) {
    const needle = caseSensitive ? term : term.toLowerCase();
    const haystack = caseSensitive ? text : text.toLowerCase();
    if (haystack.includes(needle)) {
      leaks.push(term);
    }
  }

  return { verified: leaks.length === 0, leaks };
}

module.exports = {
  hashBuffer,
  validateOutputChanged,
  verifyRedaction,
};
