const express = require("express");
const cors = require("cors");
const fileUpload = require("express-fileupload");
const path = require("path");
const fsSync = require("fs");
require("dotenv").config();

const config = require("./config");
const logger = require("./utils/logger");

const {
  normalizeFileFields,
  cleanupTempFiles,
  fileUploadErrorHandler,
} = require("./middleware/uploadMiddleware");

const os = require("os");

const app = express();
const startTime = Date.now();

// ── Process-level error handlers ─────────────────────────────────────────────
// These prevent the server from crashing silently on unhandled errors.
process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION — server staying alive", {
    message: err.message,
    stack: err.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error("UNHANDLED REJECTION — server staying alive", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Ensure temp directory exists (cross-platform)
try {
  fsSync.mkdirSync(config.tempDir, { recursive: true });
} catch (e) {
  /* ignore */
}

app.use(logger.requestLogger);

// CORS configuration — Allow all origins for mobile app
// NOTE: credentials:true requires a specific origin, not '*'.
//       When origin is '*', we disable credentials to avoid CORS errors.
app.use(
  cors({
    origin: config.frontendUrl === "*" ? true : config.frontendUrl,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: config.frontendUrl !== "*",
  }),
);

// Body parsing (only for non-multipart; these skip multipart/form-data)
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));

// File upload configuration (express-fileupload)
app.use(
  fileUpload({
    useTempFiles: true,
    tempFileDir: config.tempDir + path.sep,
    limits: {
      fileSize: config.maxFileSizeBytes,
    },
    abortOnLimit: false, // Don't silently abort — let our error handler respond
    createParentPath: true,
    parseNested: true,
    debug: false,
    uploadTimeout: config.uploadTimeout,
    safeFileNames: false, // Preserve original names
  }),
);

// Custom middleware for file handling
app.use(normalizeFileFields); // Normalize field names to all expected names
app.use(cleanupTempFiles); // Cleanup temp files after response

// Only expose debug endpoint in development
if (config.isDev) {
  const debugRouter = express.Router();
  debugRouter.post("/upload", (req, res) => {
    const info = {
      success: true,
      hasFiles: !!req.files,
      fileFields: req.files ? Object.keys(req.files) : [],
      bodyFields: req.body ? Object.keys(req.body) : [],
      contentType: req.get("content-type"),
      fileDetails: {},
    };

    if (req.files) {
      const seen = new Set();
      for (const [field, fileData] of Object.entries(req.files)) {
        const files = Array.isArray(fileData) ? fileData : [fileData];
        for (const f of files) {
          if (!seen.has(f.name + f.size)) {
            seen.add(f.name + f.size);
            if (!info.fileDetails[field]) info.fileDetails[field] = [];
            info.fileDetails[field].push({
              name: f.name,
              size: f.size,
              mimetype: f.mimetype,
              hasTempFile: !!f.tempFilePath,
            });
          }
        }
      }
    }

    res.json(info);
  });
  app.use("/debug", debugRouter);
}

app.use("/api/pdf", require("./routes/pdfRoutes"));
app.use("/api/signing", require("./routes/signingRoutes"));
app.use("/api/convert", require("./routes/convertRoutes"));
app.use("/api/ai", require("./routes/aiRoutes"));
app.use("/api/document", require("./routes/documentRoutes"));

// ── New tool routes ─────────────────────────────────────────────────────────
app.use("/api/extract-images", require("./routes/extractImagesRoutes"));
app.use("/api/batch-compress", require("./routes/batchCompressRoutes"));
app.use("/api/find-replace", require("./routes/findReplaceRoutes"));
// extract-tables removed — tool deleted per requirements
app.use("/api/qrcode", require("./routes/qrcodeRoutes"));
app.use("/api/header-footer", require("./routes/headerFooterRoutes"));
app.use("/api/highlight-export", require("./routes/highlightExportRoutes"));
app.use("/api/citations", require("./routes/citationRoutes"));
app.use("/api/pptx", require("./routes/pptxRoutes"));
app.use("/api/scientific-calc", require("./routes/scientificCalcRoutes"));

// Serve output files (for tools that return download URLs)
const { OUTPUTS_DIR, startOutputCleanup } = require("./utils/fileOutputUtils");
app.use("/outputs", express.static(OUTPUTS_DIR));
startOutputCleanup();

// ── Health checks ────────────────────────────────────────────────────────────
function healthPayload() {
  const memUsage = process.memoryUsage();
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    environment: config.env,
    port: config.port,
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    },
  };
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Inscribed Backend API is running!",
    version: "1.0.0",
    endpoints: {
      pdf: "/api/pdf/*",
      convert: "/api/convert/*",
      ai: "/api/ai/*",
      document: "/api/document/*",
    },
  });
});

app.get("/health", (req, res) => res.json(healthPayload()));
app.get("/api/health", (req, res) => res.json(healthPayload()));

// Error handling
app.use(fileUploadErrorHandler);

// Fallback error handler
app.use((err, req, res, next) => {
  logger.error("Unhandled error", {
    message: err.message,
    stack: config.isDev ? err.stack : undefined,
  });
  res.status(500).json({
    error: "Internal server error",
    message: config.isDev ? err.message : "Something went wrong",
  });
});

// ── Start server ─────────────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
  // Server-level timeouts — prevent connections from hanging forever
  server.timeout = 600000; // 10 min overall request timeout
  server.keepAliveTimeout = 65000; // slightly above typical LB idle timeouts
  server.headersTimeout = 70000;

  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(`Inscribed Backend started`);
  logger.info(`Listening on http://${config.host}:${config.port}`);
  logger.info(`Environment: ${config.env}`);
  logger.info(`Temp directory: ${config.tempDir}`);
  logger.info(`Max file size: ${config.maxFileSize}MB`);
  logger.info(`CORS origin: ${config.frontendUrl}`);

  // Log LAN addresses so the user knows which IP to use
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        logger.info(`LAN: http://${addr.address}:${config.port}`);
      }
    }
  }

  logger.info("Ready to receive requests");
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Warm up LibreOffice (fire-and-forget): pre-loads the binary/libraries so
  // the first real PPTX conversion doesn't pay first-run initialization.
  // Non-fatal if LibreOffice is absent — /api/pptx/* will report 503 honestly.
  require("./services/pptxRenderService")
    .warmUpLibreOffice()
    .catch((err) => logger.warn(`LibreOffice warm-up error: ${err.message}`));
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn("Forcing shutdown after timeout");
    process.exit(1);
  }, config.shutdownTimeout);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
