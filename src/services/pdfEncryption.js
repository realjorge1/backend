/**
 * Pure JavaScript PDF Encryption Service
 *
 * Implements PDF Standard Security Handler (Revision 3, RC4 128-bit)
 * per ISO 32000-1:2008 §7.6 (PDF Reference).
 *
 * Uses only Node.js built-in `crypto` module — no external dependencies.
 */
const crypto = require("crypto");
const { PDFDocument } = require("pdf-lib");

// Standard 32-byte padding defined in PDF spec (ISO 32000-1:2008 §7.6.3.3)
const PDF_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff,
  0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c,
  0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/**
 * Pad or truncate a password to exactly 32 bytes (Algorithm 2, step a).
 */
function padPassword(password) {
  const pwd = Buffer.from(password || "", "latin1");
  const padded = Buffer.alloc(32);
  const len = Math.min(pwd.length, 32);
  pwd.copy(padded, 0, 0, len);
  PDF_PADDING.copy(padded, len, 0, 32 - len);
  return padded;
}

/** RC4 encrypt/decrypt (symmetric) — pure JS implementation.
 *  OpenSSL 3.0+ blocks RC4, so we implement it natively. */
function rc4(key, data) {
  // Initialize S-box (KSA)
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
  // PRGA — generate keystream and XOR with data
  const result = Buffer.alloc(data.length);
  let ii = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    ii = (ii + 1) & 0xff;
    j = (j + S[ii]) & 0xff;
    const tmp = S[ii];
    S[ii] = S[j];
    S[j] = tmp;
    result[k] = data[k] ^ S[(S[ii] + S[j]) & 0xff];
  }
  return result;
}

/**
 * Compute the O (owner-password) value — Algorithm 3 of PDF spec.
 * @param {string} ownerPwd  Owner password (or same as user if single-password)
 * @param {string} userPwd   User password
 * @param {number} keyBytes  Key length in bytes (16 for 128-bit)
 */
function computeO(ownerPwd, userPwd, keyBytes) {
  let hash = crypto.createHash("md5").update(padPassword(ownerPwd)).digest();
  // Rev 3: rehash 50 times
  for (let i = 0; i < 50; i++) {
    hash = crypto.createHash("md5").update(hash.subarray(0, keyBytes)).digest();
  }
  const ownerKey = hash.subarray(0, keyBytes);

  let encrypted = padPassword(userPwd);
  // Rev 3: 20 iterations with XOR'd key
  for (let i = 0; i < 20; i++) {
    const xorKey = Buffer.alloc(keyBytes);
    for (let j = 0; j < keyBytes; j++) xorKey[j] = ownerKey[j] ^ i;
    encrypted = rc4(xorKey, encrypted);
  }
  return encrypted;
}

/**
 * Compute the file encryption key — Algorithm 2 of PDF spec.
 * @param {string} userPwd    User password
 * @param {Buffer} O          Owner-password value (32 bytes)
 * @param {number} permissions Permissions integer (signed 32-bit)
 * @param {Buffer} fileId     First element of the file /ID array
 * @param {number} keyBytes   Key length in bytes
 */
function computeEncryptionKey(userPwd, O, permissions, fileId, keyBytes) {
  const md5 = crypto.createHash("md5");
  md5.update(padPassword(userPwd));
  md5.update(O);
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  md5.update(p);
  md5.update(fileId);
  let hash = md5.digest();
  // Rev 3: rehash 50 times
  for (let i = 0; i < 50; i++) {
    hash = crypto.createHash("md5").update(hash.subarray(0, keyBytes)).digest();
  }
  return hash.subarray(0, keyBytes);
}

/**
 * Compute the U (user-password) value — Algorithm 5 of PDF spec (Rev 3).
 */
function computeU(encryptionKey, fileId) {
  const md5 = crypto.createHash("md5");
  md5.update(PDF_PADDING);
  md5.update(fileId);
  let hash = md5.digest();
  for (let i = 0; i < 20; i++) {
    const xorKey = Buffer.alloc(encryptionKey.length);
    for (let j = 0; j < encryptionKey.length; j++)
      xorKey[j] = encryptionKey[j] ^ i;
    hash = rc4(xorKey, hash);
  }
  // Pad to 32 bytes
  const U = Buffer.alloc(32);
  hash.copy(U);
  return U;
}

/**
 * Derive the per-object encryption key — Algorithm 1 of PDF spec.
 * @param {Buffer} encKey  File encryption key
 * @param {number} objNum  Object number
 * @param {number} genNum  Generation number
 */
function objectKey(encKey, objNum, genNum) {
  const md5 = crypto.createHash("md5");
  md5.update(encKey);
  // Object number as 3-byte LE
  const ob = Buffer.alloc(3);
  ob[0] = objNum & 0xff;
  ob[1] = (objNum >> 8) & 0xff;
  ob[2] = (objNum >> 16) & 0xff;
  md5.update(ob);
  // Generation number as 2-byte LE
  const gb = Buffer.alloc(2);
  gb[0] = genNum & 0xff;
  gb[1] = (genNum >> 8) & 0xff;
  md5.update(gb);
  const hash = md5.digest();
  return hash.subarray(0, Math.min(encKey.length + 5, 16));
}

// ────────────────────────────────────────────────────────────
// PDF byte-level helpers
// ────────────────────────────────────────────────────────────

/** Find a keyword in a buffer, searching backwards from `start`. */
function rfind(buf, keyword, start) {
  const kw = Buffer.from(keyword);
  for (let i = (start ?? buf.length - 1) - kw.length; i >= 0; i--) {
    if (buf.subarray(i, i + kw.length).equals(kw)) return i;
  }
  return -1;
}

/** Find a keyword in a buffer, searching forward from `start`. */
function ffind(buf, keyword, start) {
  const kw = Buffer.from(keyword);
  for (let i = start || 0; i <= buf.length - kw.length; i++) {
    if (buf.subarray(i, i + kw.length).equals(kw)) return i;
  }
  return -1;
}

/** Read ASCII text from a position until whitespace/delimiter. */
function readToken(buf, pos) {
  let s = "";
  while (pos < buf.length) {
    const ch = buf[pos];
    if (
      ch === 0x20 ||
      ch === 0x0a ||
      ch === 0x0d ||
      ch === 0x09 ||
      ch === 0x2f ||
      ch === 0x3c ||
      ch === 0x3e ||
      ch === 0x5b ||
      ch === 0x5d
    )
      break;
    s += String.fromCharCode(ch);
    pos++;
  }
  return s;
}

/** Extract the file ID from /ID [<hex1><hex2>] in the trailer. */
function extractFileId(buf) {
  const trailerPos = rfind(buf, "trailer");
  if (trailerPos < 0) {
    // Cross-reference stream — look for /ID in last 2048 bytes
    const tail = buf.subarray(Math.max(0, buf.length - 4096));
    const idPos = ffind(tail, "/ID");
    if (idPos < 0) return crypto.randomBytes(16);
    const afterId = tail.subarray(idPos + 3, idPos + 200).toString("latin1");
    const m = afterId.match(/\s*\[\s*<([0-9A-Fa-f]+)>/);
    if (m) return Buffer.from(m[1], "hex");
    return crypto.randomBytes(16);
  }
  const trailerBlock = buf
    .subarray(trailerPos, Math.min(trailerPos + 2048, buf.length))
    .toString("latin1");
  const m = trailerBlock.match(/\/ID\s*\[\s*<([0-9A-Fa-f]+)>/);
  if (m) return Buffer.from(m[1], "hex");
  return crypto.randomBytes(16);
}

// ────────────────────────────────────────────────────────────
// Main encryption function
// ────────────────────────────────────────────────────────────

/**
 * Encrypt a PDF buffer with RC4-128 (Standard Security Handler Rev 3).
 *
 * Strategy:
 *   1. Walk the cross-reference table to discover all indirect objects
 *   2. Encrypt every stream body and every literal string in each object
 *   3. Append a new /Encrypt dictionary object
 *   4. Rewrite the xref table & trailer with the /Encrypt reference
 *
 * @param {Buffer} pdfBuf         Clean (unencrypted) PDF bytes
 * @param {string} userPassword   Password the user must enter to open
 * @param {string} [ownerPassword]  Owner password (defaults to userPassword)
 * @param {number} [permissionFlags]  PDF permission bits (default: -3904 = allow printing)
 * @returns {Buffer} Encrypted PDF bytes
 */
async function encryptPdfBuffer(
  pdfBuf,
  userPassword,
  ownerPassword,
  permissionFlags,
) {
  const ownerPwd = ownerPassword || userPassword;
  // Permission flags: -3904 = 0xFFFF0CC0 (allow printing & low-res print)
  const permissions = permissionFlags ?? -3904;
  const keyBytes = 16; // 128-bit

  // ── Normalize: ensure traditional xref table ──
  // pdf-lib and many tools produce xref-stream PDFs with object streams.
  // Objects inside ObjStm are invisible to byte-level scanning, so we
  // re-save through pdf-lib with useObjectStreams:false to guarantee
  // every object is a top-level "N N obj … endobj" entry.
  let normalizedBuf = pdfBuf;
  const startxrefPos = rfind(pdfBuf, "startxref");
  if (startxrefPos < 0) throw new Error("Cannot find startxref in PDF");
  const afterSX = pdfBuf.subarray(startxrefPos + 9, startxrefPos + 40);
  const xrefOffset = parseInt(afterSX.toString("ascii").trim(), 10);
  const atXref = pdfBuf.subarray(xrefOffset, xrefOffset + 4).toString("ascii");

  if (atXref !== "xref") {
    // Cross-reference stream PDF — normalize to traditional xref
    const doc = await PDFDocument.load(pdfBuf, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    normalizedBuf = Buffer.from(
      await doc.save({ useObjectStreams: false }),
    );
  }

  // Re-parse startxref from the (possibly normalized) buffer
  const sxPos = rfind(normalizedBuf, "startxref");
  const sxAfter = normalizedBuf.subarray(sxPos + 9, sxPos + 40);
  const normXrefOffset = parseInt(sxAfter.toString("ascii").trim(), 10);

  const fileId = extractFileId(normalizedBuf);
  const O = computeO(ownerPwd, userPassword, keyBytes);
  const encKey = computeEncryptionKey(
    userPassword,
    O,
    permissions,
    fileId,
    keyBytes,
  );
  const U = computeU(encKey, fileId);

  // Traditional xref table — parse entries and encrypt
  return encryptTraditionalPdf(
    normalizedBuf,
    encKey,
    O,
    U,
    permissions,
    fileId,
    keyBytes,
    normXrefOffset,
  );
}

/**
 * Encrypt a PDF that uses a traditional xref table.
 */
function encryptTraditionalPdf(
  pdfBuf,
  encKey,
  O,
  U,
  permissions,
  fileId,
  keyBytes,
  xrefOffset,
) {
  // Parse xref table to find all objects
  const objects = parseXrefTable(pdfBuf, xrefOffset);

  // Build encrypted PDF incrementally
  const chunks = [];
  let currentPos = 0;

  // Sort objects by offset
  const sortedObjs = [...objects].sort((a, b) => a.offset - b.offset);
  const newOffsets = new Map(); // objNum -> new offset

  // Copy PDF header
  const firstObjOffset = sortedObjs.length > 0 ? sortedObjs[0].offset : 0;
  chunks.push(pdfBuf.subarray(0, firstObjOffset));
  currentPos = firstObjOffset;

  // Process each object
  for (const obj of sortedObjs) {
    const { objNum, genNum, offset } = obj;
    // Track new offset
    const newOffset = Buffer.concat(chunks).length;
    newOffsets.set(objNum, { offset: newOffset, genNum });

    // Find the end of this object (endobj keyword)
    const endObjPos = ffind(pdfBuf, "endobj", offset);
    if (endObjPos < 0) {
      // Object runs to end of file? Shouldn't happen. Copy as-is.
      chunks.push(pdfBuf.subarray(offset, pdfBuf.length));
      break;
    }
    const endPos = endObjPos + 6; // include "endobj"
    const objSlice = pdfBuf.subarray(offset, endPos);

    // Encrypt this object
    const encrypted = encryptObject(objSlice, encKey, objNum, genNum);
    chunks.push(encrypted);

    // Add any whitespace between objects
    let nextObjStart = endPos;
    // Skip whitespace
    while (
      nextObjStart < pdfBuf.length &&
      (pdfBuf[nextObjStart] === 0x0a ||
        pdfBuf[nextObjStart] === 0x0d ||
        pdfBuf[nextObjStart] === 0x20)
    ) {
      nextObjStart++;
    }
    if (nextObjStart > endPos) {
      chunks.push(pdfBuf.subarray(endPos, nextObjStart));
    }
  }

  // Determine next available object number for /Encrypt dict
  const maxObjNum = Math.max(...objects.map((o) => o.objNum), 0);
  const encryptObjNum = maxObjNum + 1;

  // Build /Encrypt dictionary object
  const encryptObj = buildEncryptObject(
    encryptObjNum,
    O,
    U,
    permissions,
    keyBytes,
  );
  const encryptObjOffset = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(encryptObj, "latin1"));

  // Build new xref table
  // PDF spec (ISO 32000-1 §7.5.4): each xref entry must be EXACTLY 20 bytes.
  // Format: "nnnnnnnnnn ggggg n\r\n" (10-digit offset, space, 5-digit gen,
  //          space, keyword, CR, LF) = 20 bytes per entry.
  const xrefStart = Buffer.concat(chunks).length;
  let xrefStr = "xref\n";
  xrefStr += `0 ${encryptObjNum + 1}\n`;
  xrefStr += "0000000000 65535 f\r\n";

  for (let i = 1; i <= encryptObjNum; i++) {
    if (i === encryptObjNum) {
      xrefStr += `${String(encryptObjOffset).padStart(10, "0")} 00000 n\r\n`;
    } else if (newOffsets.has(i)) {
      const entry = newOffsets.get(i);
      xrefStr += `${String(entry.offset).padStart(10, "0")} ${String(entry.genNum).padStart(5, "0")} n\r\n`;
    } else {
      xrefStr += "0000000000 00000 f\r\n";
    }
  }

  // Build trailer
  let trailerStr = "trailer\n<<\n";
  trailerStr += `  /Size ${encryptObjNum + 1}\n`;
  trailerStr += `  /Root ${findRootRef(pdfBuf)}\n`;
  trailerStr += `  /Encrypt ${encryptObjNum} 0 R\n`;
  trailerStr += `  /ID [<${fileId.toString("hex")}> <${fileId.toString("hex")}>]\n`;
  const infoRef = findInfoRef(pdfBuf);
  if (infoRef) trailerStr += `  /Info ${infoRef}\n`;
  trailerStr += ">>\nstartxref\n";
  trailerStr += `${xrefStart}\n`;
  trailerStr += "%%EOF\n";

  chunks.push(Buffer.from(xrefStr, "latin1"));
  chunks.push(Buffer.from(trailerStr, "latin1"));

  return Buffer.concat(chunks);
}

/**
 * For cross-reference stream PDFs, rebuild with traditional xref.
 * This is a simpler approach: re-serialize the PDF using pdf-lib first,
 * then encrypt the serialized output.
 */
function encryptWithRebuiltXref(
  pdfBuf,
  encKey,
  O,
  U,
  permissions,
  fileId,
  keyBytes,
) {
  // Walk through the PDF finding objects by scanning for "N N obj" patterns
  const objects = scanForObjects(pdfBuf);

  const chunks = [];

  // Write header
  const headerEnd = pdfBuf.indexOf(0x0a, 0) + 1;
  chunks.push(pdfBuf.subarray(0, headerEnd));
  // Add binary marker
  chunks.push(Buffer.from("%\xE2\xE3\xCF\xD3\n", "latin1"));

  const newOffsets = new Map();

  // Sort by offset
  objects.sort((a, b) => a.offset - b.offset);

  for (const obj of objects) {
    const { objNum, genNum, offset } = obj;
    const newOffset = Buffer.concat(chunks).length;
    newOffsets.set(objNum, { offset: newOffset, genNum });

    const endObjPos = ffind(pdfBuf, "endobj", offset);
    if (endObjPos < 0) continue;
    const endPos = endObjPos + 6;
    const objSlice = pdfBuf.subarray(offset, endPos);

    // Skip xref stream objects (they contain /Type /XRef)
    const objStr = objSlice.toString("latin1");
    if (objStr.includes("/Type /XRef") || objStr.includes("/Type/XRef")) {
      // Don't include xref stream objects — we'll use a traditional xref
      newOffsets.delete(objNum);
      continue;
    }

    const encrypted = encryptObject(objSlice, encKey, objNum, genNum);
    chunks.push(encrypted);
    chunks.push(Buffer.from("\n", "latin1"));
  }

  // Add /Encrypt dictionary object
  const maxObjNum = Math.max(...[...newOffsets.keys()], 0);
  const encryptObjNum = maxObjNum + 1;
  const encryptObj = buildEncryptObject(
    encryptObjNum,
    O,
    U,
    permissions,
    keyBytes,
  );
  const encryptObjOffset = Buffer.concat(chunks).length;
  chunks.push(Buffer.from(encryptObj, "latin1"));

  newOffsets.set(encryptObjNum, { offset: encryptObjOffset, genNum: 0 });

  // Build xref table
  const xrefStart = Buffer.concat(chunks).length;
  const allObjNums = [...newOffsets.keys()].sort((a, b) => a - b);
  const maxNum = Math.max(...allObjNums, encryptObjNum);

  let xrefStr = "xref\n";
  xrefStr += `0 ${maxNum + 1}\n`;
  xrefStr += "0000000000 65535 f\r\n";
  for (let i = 1; i <= maxNum; i++) {
    if (newOffsets.has(i)) {
      const e = newOffsets.get(i);
      xrefStr += `${String(e.offset).padStart(10, "0")} ${String(e.genNum).padStart(5, "0")} n\r\n`;
    } else {
      xrefStr += "0000000000 00000 f\r\n";
    }
  }
  chunks.push(Buffer.from(xrefStr, "latin1"));

  // Build trailer
  const rootRef = findRootRef(pdfBuf);
  let trailerStr = "trailer\n<<\n";
  trailerStr += `  /Size ${maxNum + 1}\n`;
  trailerStr += `  /Root ${rootRef}\n`;
  trailerStr += `  /Encrypt ${encryptObjNum} 0 R\n`;
  trailerStr += `  /ID [<${fileId.toString("hex")}> <${fileId.toString("hex")}>]\n`;
  const infoRef = findInfoRef(pdfBuf);
  if (infoRef) trailerStr += `  /Info ${infoRef}\n`;
  trailerStr += ">>\n";
  trailerStr += "startxref\n";
  trailerStr += `${xrefStart}\n`;
  trailerStr += "%%EOF\n";
  chunks.push(Buffer.from(trailerStr, "latin1"));

  return Buffer.concat(chunks);
}

// ────────────────────────────────────────────────────────────
// Object encryption
// ────────────────────────────────────────────────────────────

/**
 * Encrypt all strings and streams within a single PDF object.
 */
function encryptObject(objBuf, encKey, objNum, genNum) {
  const key = objectKey(encKey, objNum, genNum);
  let result = Buffer.from(objBuf); // copy

  // 1. Encrypt stream content — use /Length from dict to get exact byte count
  const streamStart = findStreamStart(result);
  if (streamStart >= 0) {
    const dictStr = result.subarray(0, streamStart).toString("latin1");
    const lenMatch = dictStr.match(/\/Length\s+(\d+)/);
    let streamLen;
    if (lenMatch) {
      streamLen = parseInt(lenMatch[1]);
    } else {
      // Fallback: use endstream marker
      const endstreamPos = rfind(result, "endstream", result.length);
      streamLen = endstreamPos > streamStart ? endstreamPos - streamStart : 0;
    }
    if (streamLen > 0 && streamStart + streamLen <= result.length) {
      const plainStream = result.subarray(streamStart, streamStart + streamLen);
      const encryptedStream = rc4(key, plainStream);
      encryptedStream.copy(result, streamStart);
    }
  }

  // 2. Encrypt literal strings (parenthesized)
  // We do this in the dictionary portion (before "stream" keyword if present)
  const dictEnd = streamStart >= 0 ? streamStart : result.length;
  result = encryptStringsInRange(result, 0, dictEnd, key);

  return result;
}

/**
 * Find the start of stream content (after "stream\r\n" or "stream\n").
 */
function findStreamStart(buf) {
  const pos = ffind(buf, "stream");
  if (pos < 0) return -1;
  let i = pos + 6; // skip "stream"
  if (i < buf.length && buf[i] === 0x0d) i++; // skip \r
  if (i < buf.length && buf[i] === 0x0a) i++; // skip \n
  return i;
}

/**
 * Encrypt all literal strings (in parentheses) within a byte range.
 * Preserves hex strings (<...>) and name objects (/...) as-is.
 */
function encryptStringsInRange(buf, start, end, key) {
  const out = [];
  let i = start;

  // Copy everything before start
  if (start > 0) out.push(buf.subarray(0, start));

  while (i < end) {
    if (buf[i] === 0x28) {
      // '(' — start of literal string
      // Find matching ')' accounting for nesting and escapes
      const strStart = i;
      let depth = 1;
      let j = i + 1;
      while (j < end && depth > 0) {
        if (buf[j] === 0x5c) {
          j += 2; // skip escape
          continue;
        }
        if (buf[j] === 0x28) depth++;
        if (buf[j] === 0x29) depth--;
        j++;
      }
      // strStart..j is the complete string including parens
      const strContent = buf.subarray(strStart + 1, j - 1);
      const encrypted = rc4(key, strContent);

      out.push(Buffer.from("("));
      // Escape special chars in encrypted bytes
      const escapedBytes = [];
      for (const b of encrypted) {
        if (b === 0x28 || b === 0x29 || b === 0x5c) {
          escapedBytes.push(0x5c); // backslash
        }
        escapedBytes.push(b);
      }
      out.push(Buffer.from(escapedBytes));
      out.push(Buffer.from(")"));
      i = j;
    } else {
      // Find next '(' or end
      let next = i;
      while (next < end && buf[next] !== 0x28) next++;
      out.push(buf.subarray(i, next));
      i = next;
    }
  }

  // Append everything after end (including stream content if any)
  if (end < buf.length) out.push(buf.subarray(end));

  return Buffer.concat(out);
}

// ────────────────────────────────────────────────────────────
// PDF structure helpers
// ────────────────────────────────────────────────────────────

function parseXrefTable(buf, xrefOffset) {
  const objects = [];
  const text = buf
    .subarray(xrefOffset, Math.min(xrefOffset + 65536, buf.length))
    .toString("latin1");
  const lines = text.split(/\r?\n/);

  let currentStart = 0;
  let i = 1; // skip "xref" line
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "trailer" || line.startsWith("trailer")) break;

    // Subsection header: startObj count
    const headerMatch = line.match(/^(\d+)\s+(\d+)$/);
    if (headerMatch) {
      currentStart = parseInt(headerMatch[1]);
      const count = parseInt(headerMatch[2]);
      for (let j = 0; j < count && i + 1 + j < lines.length; j++) {
        const entryLine = lines[i + 1 + j].trim();
        const entryMatch = entryLine.match(/^(\d{10})\s+(\d{5})\s+([nf])\s*$/);
        if (entryMatch && entryMatch[3] === "n") {
          objects.push({
            objNum: currentStart + j,
            genNum: parseInt(entryMatch[2]),
            offset: parseInt(entryMatch[1]),
          });
        }
      }
      i += 1 + count;
    } else {
      i++;
    }
  }
  return objects;
}

/** Scan PDF bytes for "N N obj" patterns to find all objects. */
function scanForObjects(buf) {
  const objects = [];
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  const text = buf.toString("latin1");
  let match;
  while ((match = re.exec(text)) !== null) {
    objects.push({
      objNum: parseInt(match[1]),
      genNum: parseInt(match[2]),
      offset: match.index,
    });
  }
  return objects;
}

/** Find the /Root reference in the trailer or xref stream. */
function findRootRef(buf) {
  const text = buf.toString("latin1");
  // Try trailer dict first
  const rootMatch = text.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  if (rootMatch) return rootMatch[1];
  return "1 0 R"; // fallback
}

/** Find the /Info reference in the trailer or xref stream. */
function findInfoRef(buf) {
  const text = buf.toString("latin1");
  const infoMatch = text.match(/\/Info\s+(\d+\s+\d+\s+R)/);
  return infoMatch ? infoMatch[1] : null;
}

/** Build the /Encrypt dictionary as a PDF indirect object. */
function buildEncryptObject(objNum, O, U, permissions, keyBytes) {
  let s = `${objNum} 0 obj\n`;
  s += "<<\n";
  s += "  /Filter /Standard\n";
  s += "  /V 2\n"; // V=2 for variable-length key up to 128 bits
  s += "  /R 3\n"; // Rev 3
  s += `  /Length ${keyBytes * 8}\n`;
  s += `  /P ${permissions}\n`;
  s += `  /O <${O.toString("hex")}>\n`;
  s += `  /U <${U.toString("hex")}>\n`;
  s += ">>\n";
  s += "endobj\n";
  return s;
}

// ────────────────────────────────────────────────────────────
// Decryption (inverse of encryption; RC4 is symmetric)
// ────────────────────────────────────────────────────────────

/**
 * Parse the /Encrypt Standard-security dictionary from an encrypted PDF.
 * Only handles V≤2 / R≤3 (RC4 up to 128-bit), which is what encryptPdfBuffer
 * produces.  Returns null if the dictionary is absent or unsupported.
 */
function parseEncryptDict(pdfBuf) {
  const text = pdfBuf.toString("latin1");

  // Find the /Encrypt indirect reference in the trailer or xref-stream tail.
  let encryptObjNum = null;
  const trailerPos = rfind(pdfBuf, "trailer");
  if (trailerPos >= 0) {
    const trailerText = text.substring(
      trailerPos,
      Math.min(trailerPos + 512, text.length),
    );
    const m = trailerText.match(/\/Encrypt\s+(\d+)\s+\d+\s+R/);
    if (m) encryptObjNum = parseInt(m[1]);
  }
  if (encryptObjNum === null) {
    const tail = text.substring(Math.max(0, text.length - 4096));
    const m = tail.match(/\/Encrypt\s+(\d+)\s+\d+\s+R/);
    if (m) encryptObjNum = parseInt(m[1]);
  }
  if (encryptObjNum === null) return null;

  // Find the /Encrypt object body.
  const objPattern = new RegExp(`\\b${encryptObjNum}\\s+0\\s+obj\\b`);
  const objMatch = objPattern.exec(text);
  if (!objMatch) return null;
  const objEnd = text.indexOf("endobj", objMatch.index);
  if (objEnd < 0) return null;
  const objText = text.substring(objMatch.index, objEnd + 6);

  const filterM = objText.match(/\/Filter\s*\/(\w+)/);
  if (!filterM || filterM[1] !== "Standard") return null;

  const vM = objText.match(/\/V\s+(\d+)/);
  const rM = objText.match(/\/R\s+(\d+)/);
  const lenM = objText.match(/\/Length\s+(\d+)/);
  const pM = objText.match(/\/P\s+(-?\d+)/);
  const oM = objText.match(/\/O\s*<([0-9A-Fa-f]+)>/);
  const uM = objText.match(/\/U\s*<([0-9A-Fa-f]+)>/);

  if (!vM || !rM || !oM || !uM || !pM) return null;

  const V = parseInt(vM[1]);
  const R = parseInt(rM[1]);
  if (V > 2 || R > 3) return null; // AES or newer — unsupported by this decryptor

  return {
    V,
    R,
    keyBytes: lenM ? Math.floor(parseInt(lenM[1]) / 8) : V === 1 ? 5 : 16,
    P: parseInt(pM[1]),
    O: Buffer.from(oM[1], "hex"),
    U: Buffer.from(uM[1], "hex"),
    objNum: encryptObjNum,
  };
}

/**
 * Attempt to verify the owner password (Algorithm 7, Rev 3).
 * If correct, returns the derived file encryption key; otherwise returns null.
 */
function deriveKeyFromOwnerPassword(ownerPassword, O, U, P, fileId, keyBytes) {
  let hash = crypto
    .createHash("md5")
    .update(padPassword(ownerPassword))
    .digest();
  for (let i = 0; i < 50; i++) {
    hash = crypto.createHash("md5").update(hash.subarray(0, keyBytes)).digest();
  }
  const ownerKey = hash.subarray(0, keyBytes);

  // Decrypt /O with 20 descending-XOR RC4 rounds (Rev 3 Algorithm 7c).
  let data = Buffer.from(O);
  for (let i = 19; i >= 0; i--) {
    const xorKey = Buffer.alloc(keyBytes);
    for (let j = 0; j < keyBytes; j++) xorKey[j] = ownerKey[j] ^ i;
    data = rc4(xorKey, data);
  }

  // 'data' is the padded user password — try it.
  const encKey = computeEncryptionKey(
    data.toString("latin1"),
    O,
    P,
    fileId,
    keyBytes,
  );
  const computedU = computeU(encKey, fileId);
  return computedU.subarray(0, 16).equals(U.subarray(0, 16)) ? encKey : null;
}

/**
 * Decrypt a PDF encrypted by encryptPdfBuffer (RC4-128, Standard V=1/2 R=2/3).
 *
 * RC4 is self-inverse: applying it twice with the same key recovers the
 * original plaintext.  This function walks all objects found via the
 * traditional xref table (which encryptPdfBuffer always emits), RC4-decrypts
 * each object's stream content and string values, removes the /Encrypt
 * object, and rebuilds a plain trailer without the /Encrypt reference.
 *
 * @param {Buffer} pdfBuf   Encrypted PDF bytes.
 * @param {string} password User or owner password.
 * @returns {Buffer} Decrypted PDF bytes.
 * @throws {Error} "Incorrect password" if verification fails.
 * @throws {Error} Non-password errors if the PDF structure is unsupported.
 */
function decryptPdfBuffer(pdfBuf, password) {
  // ── 1. Parse /Encrypt ────────────────────────────────────
  const encDict = parseEncryptDict(pdfBuf);
  if (!encDict) {
    throw new Error(
      "No Standard encryption dictionary found. " +
        "Cannot decrypt with built-in decryptor.",
    );
  }

  // ── 2. Get file identifier ───────────────────────────────
  const fileId = extractFileId(pdfBuf);
  const { O, U, P, keyBytes } = encDict;

  // ── 3. Verify password ───────────────────────────────────
  let encKey = null;
  const userKey = computeEncryptionKey(password, O, P, fileId, keyBytes);
  const computedU = computeU(userKey, fileId);
  if (computedU.subarray(0, 16).equals(U.subarray(0, 16))) {
    encKey = userKey;
  } else {
    encKey = deriveKeyFromOwnerPassword(password, O, U, P, fileId, keyBytes);
    if (!encKey) {
      throw new Error("Incorrect password");
    }
  }

  // ── 4. Find all objects via xref table ───────────────────
  const startxrefPos = rfind(pdfBuf, "startxref");
  if (startxrefPos < 0) {
    throw new Error("Cannot find startxref. PDF may be damaged.");
  }
  const xrefOffset = parseInt(
    pdfBuf
      .subarray(startxrefPos + 9, startxrefPos + 40)
      .toString("ascii")
      .trim(),
  );

  let objects;
  const atXref = pdfBuf.subarray(xrefOffset, xrefOffset + 4).toString("ascii");
  if (atXref === "xref") {
    objects = parseXrefTable(pdfBuf, xrefOffset);
  } else {
    // xref-stream PDF — scan as fallback (less reliable for ObjStm PDFs).
    objects = scanForObjects(pdfBuf);
  }
  if (objects.length === 0) {
    throw new Error(
      "No objects found. PDF may use xref-stream format. Please use qpdf to decrypt.",
    );
  }

  // ── 5. RC4-decrypt every object, drop /Encrypt object ───
  objects.sort((a, b) => a.offset - b.offset);
  const newOffsets = new Map();
  const chunks = [];

  // Preserve the PDF header (bytes before the first object).
  chunks.push(pdfBuf.subarray(0, objects[0].offset));

  for (const { objNum, genNum, offset } of objects) {
    if (objNum === encDict.objNum) continue; // drop /Encrypt dict object

    const newOffset = Buffer.concat(chunks).length;
    newOffsets.set(objNum, { offset: newOffset, genNum });

    const endPos = ffind(pdfBuf, "endobj", offset);
    if (endPos < 0) continue;
    const objSlice = pdfBuf.subarray(offset, endPos + 6);

    // RC4 is symmetric: re-applying with the same key decrypts.
    const decrypted = encryptObject(objSlice, encKey, objNum, genNum);
    chunks.push(decrypted);
    chunks.push(Buffer.from("\n", "latin1"));
  }

  // ── 6. Rebuild xref + trailer without /Encrypt ──────────
  const maxObjNum = Math.max(...newOffsets.keys(), 0);
  const xrefStart = Buffer.concat(chunks).length;

  let xrefStr = "xref\n";
  xrefStr += `0 ${maxObjNum + 1}\n`;
  xrefStr += "0000000000 65535 f\r\n";
  for (let i = 1; i <= maxObjNum; i++) {
    if (newOffsets.has(i)) {
      const e = newOffsets.get(i);
      xrefStr += `${String(e.offset).padStart(10, "0")} ${String(e.genNum).padStart(5, "0")} n\r\n`;
    } else {
      xrefStr += "0000000000 00000 f\r\n";
    }
  }
  chunks.push(Buffer.from(xrefStr, "latin1"));

  const rootRef = findRootRef(pdfBuf);
  let trailerStr = "trailer\n<<\n";
  trailerStr += `  /Size ${maxObjNum + 1}\n`;
  trailerStr += `  /Root ${rootRef}\n`;
  const infoRef = findInfoRef(pdfBuf);
  if (infoRef) trailerStr += `  /Info ${infoRef}\n`;
  trailerStr += ">>\nstartxref\n";
  trailerStr += `${xrefStart}\n`;
  trailerStr += "%%EOF\n";
  chunks.push(Buffer.from(trailerStr, "latin1"));

  return Buffer.concat(chunks);
}

module.exports = { encryptPdfBuffer, decryptPdfBuffer };
