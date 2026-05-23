/**
 * PDFLab Encryption Service — AES-256-GCM
 *
 * Provides high-security encryption for PDF files using:
 *   - PBKDF2-HMAC-SHA256 key derivation (210,000 iterations per OWASP 2024)
 *   - AES-256-GCM authenticated encryption
 *   - Random salt + IV per encryption
 *   - AAD (Additional Authenticated Data) for tamper-proof metadata
 *
 * Produces .pdflab binary files which are NOT standard PDFs — they must
 * be decrypted before viewing.
 *
 * Binary layout:
 *   [ MAGIC(7) | VERSION(1) | ITERATIONS(4) | SALT(16) | IV(12) | TAG(16) | CIPHERTEXT ]
 */

const crypto = require("crypto");

// ─── Constants ────────────────────────────────────────────────────────────────
const MAGIC = Buffer.from("PDFLAB1"); // 7 bytes — file identifier
const VERSION = 1; // 1 byte
const KDF_ALGO = "sha256";
const ITERATIONS = 210_000; // OWASP 2024 recommendation
const SALT_LEN = 16; // bytes
const IV_LEN = 12; // bytes  (96-bit — GCM standard)
const TAG_LEN = 16; // bytes  (128-bit auth tag)
const KEY_LEN = 32; // bytes  (256-bit AES key)

// ─── Key Derivation ───────────────────────────────────────────────────────────
/**
 * Derives a 256-bit AES key from a password + salt using PBKDF2-HMAC-SHA256.
 * @param {string} password
 * @param {Buffer} salt
 * @returns {Promise<Buffer>} 32-byte key
 */
function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LEN, KDF_ALGO, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

// ─── Encrypt ──────────────────────────────────────────────────────────────────
/**
 * Encrypts raw PDF bytes with AES-256-GCM.
 *
 * @param {Buffer} pdfBytes   — raw PDF file bytes
 * @param {string} password   — user password (min 6 chars)
 * @returns {Promise<Buffer>} — encrypted .pdflab blob
 */
async function encryptPDF(pdfBytes, password) {
  // 1. Random salt + IV
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);

  // 2. Derive key
  const key = await deriveKey(password, salt);

  // 3. Build AAD (Additional Authenticated Data)
  //    Uses only deterministic fields so decrypt can rebuild the same AAD.
  const aad = Buffer.from(
    JSON.stringify({ magic: "PDFLAB1", version: VERSION }),
  );

  // 4. Encrypt
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(pdfBytes), cipher.final()]);

  const tag = cipher.getAuthTag(); // 16 bytes

  // 5. Pack into binary blob
  const iterBuf = Buffer.allocUnsafe(4);
  iterBuf.writeUInt32BE(ITERATIONS, 0);

  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    iterBuf,
    salt,
    iv,
    tag,
    ciphertext,
  ]);
}

// ─── Decrypt ──────────────────────────────────────────────────────────────────
/**
 * Decrypts an encrypted .pdflab blob produced by encryptPDF().
 *
 * @param {Buffer} encryptedBlob  — full encrypted file bytes
 * @param {string} password       — user password
 * @returns {Promise<Buffer>}     — original PDF bytes
 * @throws if password is wrong or file is tampered/corrupted
 */
async function decryptPDF(encryptedBlob, password) {
  // ── Validate magic header
  const magic = encryptedBlob.slice(0, 7);
  if (!magic.equals(MAGIC)) {
    throw new Error(
      "NOT_ENCRYPTED_FILE: This file was not encrypted by PDFLab.",
    );
  }

  // ── Parse header
  let offset = 7;

  const version = encryptedBlob[offset++];
  if (version !== 1) throw new Error(`UNSUPPORTED_VERSION: ${version}`);

  const iterations = encryptedBlob.readUInt32BE(offset);
  offset += 4;

  const salt = encryptedBlob.slice(offset, offset + SALT_LEN);
  offset += SALT_LEN;
  const iv = encryptedBlob.slice(offset, offset + IV_LEN);
  offset += IV_LEN;
  const tag = encryptedBlob.slice(offset, offset + TAG_LEN);
  offset += TAG_LEN;
  const ciphertext = encryptedBlob.slice(offset);

  // ── Derive key
  const key = await new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, KEY_LEN, KDF_ALGO, (err, k) =>
      err ? reject(err) : resolve(k),
    );
  });

  // ── Rebuild AAD (must match what was used during encryption)
  const aad = Buffer.from(JSON.stringify({ magic: "PDFLAB1", version }));

  // ── Decrypt
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext;
  } catch {
    throw new Error(
      "WRONG_PASSWORD_OR_CORRUPTED: Decryption failed. Check your password or file integrity.",
    );
  }
}

// ─── Header Inspector ─────────────────────────────────────────────────────────
/**
 * Quickly checks if a buffer is a PDFLab-encrypted file (no password needed).
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isEncryptedPDFLabFile(buf) {
  return (
    Buffer.isBuffer(buf) && buf.length > 7 && buf.slice(0, 7).equals(MAGIC)
  );
}

module.exports = { encryptPDF, decryptPDF, isEncryptedPDFLabFile };
