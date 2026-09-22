/**
 * Builds an Express app carrying the same middleware chain the real server
 * puts in front of /api/ai, without pulling in the PDF/office routes (whose
 * native modules are slow to load and irrelevant here).
 */

const express = require("express");
const fileUpload = require("express-fileupload");
const os = require("os");
const path = require("path");

const { mountAiApi } = require("../../src/ai/mountAiApi");
const {
  normalizeFileFields,
  cleanupTempFiles,
} = require("../../src/middleware/uploadMiddleware");

function buildTestApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));
  app.use(
    fileUpload({
      useTempFiles: true,
      tempFileDir: path.join(os.tmpdir(), "inscribed-test") + path.sep,
      createParentPath: true,
      abortOnLimit: false,
    }),
  );
  app.use(normalizeFileFields);
  app.use(cleanupTempFiles);
  mountAiApi(app);
  return app;
}

module.exports = { buildTestApp };
