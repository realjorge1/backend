const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// Temp directory for writing decoded base64 files
const TEMP_DIR =
  process.env.TEMP_DIR || path.join(os.tmpdir(), "docu-assistant");
const DEBUG_UPLOADS = process.env.DEBUG_UPLOADS === "true";
try {
  fsSync.mkdirSync(TEMP_DIR, { recursive: true });
} catch (e) {
  /* ignore */
}

/**
 * Middleware to normalize uploaded files so they are available under
 * EVERY expected field name, regardless of what the frontend uses.
 *
 * Frontend may send: file, files, pdf, document, upload, attachment, etc.
 * Routes expect:     pdf, pdfs, document, image, images, form
 *
 * This middleware makes uploaded file(s) available under ALL expected names.
 *
 * It ALSO handles the case where mobile apps send base64-encoded files
 * inside a JSON body (common in React Native / Flutter).
 */
const normalizeFileFields = async (req, res, next) => {
  const contentType = req.get("content-type") || "";
  const isMultipart = contentType.includes("multipart");

  // Only log for POST/PUT requests when debug is enabled
  if (DEBUG_UPLOADS && (req.method === "POST" || req.method === "PUT")) {
    console.log(
      `📥 ${req.method} ${req.path} | ${isMultipart ? "multipart" : contentType.split(";")[0]}`,
    );
  }

  // STEP 1: Handle base64-encoded files in JSON body (mobile apps)
  if (!req.files && req.body) {
    const decoded = await extractBase64Files(req.body);
    if (decoded.length > 0) {
      req.files = {};
      for (const file of decoded) {
        req.files[file.fieldName] = file;
      }
      if (DEBUG_UPLOADS)
        console.log(
          `  📦 Decoded ${decoded.length} base64 file(s) from JSON body`,
        );
    }
  }

  // STEP 2: Normalize field names
  if (req.files && Object.keys(req.files).length > 0) {
    const originalFields = Object.keys(req.files);

    // Collect all individual files and all file arrays
    let firstSingleFile = null;
    const allFiles = [];

    for (const [fieldName, fileData] of Object.entries(req.files)) {
      if (Array.isArray(fileData)) {
        allFiles.push(...fileData);
        if (!firstSingleFile) firstSingleFile = fileData[0];
        if (DEBUG_UPLOADS)
          console.log(
            `  📁 ${fieldName}: ${fileData.length} files [${fileData.map((f) => f.name).join(", ")}]`,
          );
      } else {
        allFiles.push(fileData);
        if (!firstSingleFile) firstSingleFile = fileData;
        if (DEBUG_UPLOADS)
          console.log(
            `  📁 ${fieldName}: ${fileData.name} (${(fileData.size / 1024).toFixed(1)} KB)`,
          );
      }
    }

    // Make the file(s) available under ALL single-file field names
    const singleFileNames = [
      "pdf",
      "file",
      "document",
      "image",
      "form",
      "upload",
    ];
    for (const name of singleFileNames) {
      if (!req.files[name] && firstSingleFile) {
        req.files[name] = firstSingleFile;
      }
    }

    // Make the file(s) available under ALL multi-file field names
    const multiFileNames = ["pdfs", "files", "documents", "images"];
    if (allFiles.length > 0) {
      for (const name of multiFileNames) {
        if (!req.files[name]) {
          req.files[name] = allFiles.length === 1 ? allFiles : [...allFiles];
        }
      }
    }

    if (DEBUG_UPLOADS)
      console.log(
        `  ✅ Original: [${originalFields}] → Available as: [${Object.keys(req.files).join(", ")}]`,
      );
  } else if (isMultipart && DEBUG_UPLOADS) {
    console.log("  ⚠️  Multipart request but NO FILES received");
    console.log(
      "     Possible cause: Content-Type header set manually without boundary",
    );
    console.log(
      "     Fix: Remove Content-Type header from fetch() and let browser set it",
    );
  }

  next();
};

/**
 * Extract base64-encoded files from a JSON body.
 * Handles common mobile patterns:
 *   { file: "data:application/pdf;base64,JVBERi0..." }
 *   { file: "JVBERi0..." }  (raw base64 starting with PDF magic)
 *   { fileData: "...", fileName: "doc.pdf", fileType: "application/pdf" }
 *   { file: { uri: "data:...", name: "doc.pdf", type: "..." } }
 */
async function extractBase64Files(body) {
  const files = [];
  if (!body || typeof body !== "object") return files;

  // Known field patterns for file data
  const fieldPairs = [
    { dataField: "file", nameField: "fileName", typeField: "fileType" },
    { dataField: "fileData", nameField: "fileName", typeField: "fileType" },
    { dataField: "pdf", nameField: "pdfName", typeField: "pdfType" },
    {
      dataField: "document",
      nameField: "documentName",
      typeField: "documentType",
    },
    { dataField: "base64", nameField: "fileName", typeField: "fileType" },
    { dataField: "data", nameField: "fileName", typeField: "fileType" },
  ];

  for (const { dataField, nameField, typeField } of fieldPairs) {
    const rawData = body[dataField];
    if (!rawData) continue;

    // Case 1: Direct base64 string
    if (typeof rawData === "string") {
      const file = await decodeBase64ToFile(
        rawData,
        body[nameField],
        body[typeField],
        dataField,
      );
      if (file) files.push(file);
    }

    // Case 2: Object with uri/data property (React Native style)
    if (typeof rawData === "object" && !Array.isArray(rawData)) {
      const data = rawData.uri || rawData.data || rawData.base64;
      if (typeof data === "string") {
        const file = await decodeBase64ToFile(
          data,
          rawData.name || body[nameField],
          rawData.type || body[typeField],
          dataField,
        );
        if (file) files.push(file);
      }
    }

    // Case 3: Array of base64 strings or objects
    if (Array.isArray(rawData)) {
      for (const item of rawData) {
        if (typeof item === "string") {
          const file = await decodeBase64ToFile(item, null, null, dataField);
          if (file) files.push(file);
        } else if (typeof item === "object") {
          const data = item.uri || item.data || item.base64;
          if (typeof data === "string") {
            const file = await decodeBase64ToFile(
              data,
              item.name,
              item.type,
              dataField,
            );
            if (file) files.push(file);
          }
        }
      }
    }
  }

  return files;
}

/**
 * Decode a base64 string to a file object compatible with express-fileupload format
 */
async function decodeBase64ToFile(data, fileName, mimeType, fieldName) {
  if (!data || typeof data !== "string") return null;

  let base64Data = data;
  let detectedMime = mimeType || "application/pdf";

  // Strip data URI prefix: "data:application/pdf;base64,..."
  const dataUriMatch = data.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUriMatch) {
    detectedMime = dataUriMatch[1];
    base64Data = dataUriMatch[2];
  }

  // Validate it looks like base64 (min 100 chars to avoid false positives)
  if (base64Data.length < 100) return null;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64Data.substring(0, 200))) return null;

  try {
    const buffer = Buffer.from(base64Data, "base64");
    if (buffer.length < 10) return null;

    // Write to temp file (services expect file.tempFilePath)
    const tempName = `b64-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const ext = mimeToExt(detectedMime);
    const tempPath = path.join(TEMP_DIR, `${tempName}${ext}`);
    await fs.writeFile(tempPath, buffer);

    return {
      fieldName,
      name: fileName || `upload${ext}`,
      tempFilePath: tempPath,
      data: buffer,
      size: buffer.length,
      mimetype: detectedMime,
      mv: async (targetPath) => {
        await fs.copyFile(tempPath, targetPath);
      },
    };
  } catch (e) {
    console.error("Base64 decode error:", e.message);
    return null;
  }
}

function mimeToExt(mime) {
  const map = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return map[mime] || "";
}

/**
 * Cleanup temp files after response is sent.
 * Uses res.on('finish') which is safe across Express versions.
 */
const cleanupTempFiles = (req, res, next) => {
  res.on("finish", async () => {
    if (!req.files) return;

    // Collect unique temp file paths (same file may be referenced under multiple field names)
    const seen = new Set();
    for (const fileData of Object.values(req.files)) {
      const files = Array.isArray(fileData) ? fileData : [fileData];
      for (const file of files) {
        if (file.tempFilePath && !seen.has(file.tempFilePath)) {
          seen.add(file.tempFilePath);
          try {
            await fs.unlink(file.tempFilePath);
          } catch (error) {
            if (error.code !== "ENOENT") {
              console.error(
                `Cleanup failed ${file.tempFilePath}:`,
                error.message,
              );
            }
          }
        }
      }
    }
  });

  next();
};

/**
 * Enhanced error handler with detailed file upload diagnostics
 */
const fileUploadErrorHandler = (err, req, res, next) => {
  console.error("❌ ERROR:", err.message);
  console.error(err.stack);

  // Handle specific express-fileupload errors
  if (err.name === "RequestEntityTooLarge" || err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "File too large",
      message: "Maximum file size is 50MB",
      limit: "50MB",
    });
  }

  if (err.message.includes("Unsupported media type")) {
    return res.status(415).json({
      error: "Unsupported file type",
      message: "Only PDF and image files are supported",
    });
  }

  // Generic error
  res.status(500).json({
    error: "Processing failed",
    message: err.message || "An unexpected error occurred",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};

/**
 * Validate that files are present with helpful error messages
 */
const requireFiles = (fieldNames = ["pdf"]) => {
  return (req, res, next) => {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({
        error: "No files uploaded",
        message: "Please upload at least one file",
        expectedFields: fieldNames,
        receivedFields: [],
        hint: "Ensure Content-Type is multipart/form-data and field name matches",
      });
    }

    // Check if any of the expected field names exist
    const hasRequiredField = fieldNames.some((field) => req.files[field]);

    if (!hasRequiredField) {
      const receivedFields = Object.keys(req.files);
      return res.status(400).json({
        error: "Wrong field name",
        message: `Expected field(s): ${fieldNames.join(" or ")}`,
        expectedFields: fieldNames,
        receivedFields: receivedFields,
        hint: `You sent: ${receivedFields.join(", ")}. Try using field name: ${fieldNames[0]}`,
      });
    }

    next();
  };
};

module.exports = {
  normalizeFileFields,
  cleanupTempFiles,
  fileUploadErrorHandler,
  requireFiles,
};
