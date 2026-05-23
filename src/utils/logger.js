// ============================================
// FILE: utils/logger.js
// Simple production-ready logger
// ============================================
const config = require("../config");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const LOG_LEVEL =
  LEVELS[process.env.LOG_LEVEL || (config.isDev ? "debug" : "info")];

function timestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, meta) {
  const base = `[${timestamp()}] ${level.toUpperCase()}: ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    return `${base} ${JSON.stringify(meta)}`;
  }
  return base;
}

const logger = {
  error(message, meta = {}) {
    if (LOG_LEVEL >= LEVELS.error) {
      console.error(formatMessage("error", message, meta));
    }
  },

  warn(message, meta = {}) {
    if (LOG_LEVEL >= LEVELS.warn) {
      console.warn(formatMessage("warn", message, meta));
    }
  },

  info(message, meta = {}) {
    if (LOG_LEVEL >= LEVELS.info) {
      console.log(formatMessage("info", message, meta));
    }
  },

  debug(message, meta = {}) {
    if (LOG_LEVEL >= LEVELS.debug) {
      console.log(formatMessage("debug", message, meta));
    }
  },

  // Middleware: log incoming requests
  requestLogger(req, res, next) {
    const start = Date.now();
    const { method, url } = req;

    res.on("finish", () => {
      const duration = Date.now() - start;
      const level =
        res.statusCode >= 500
          ? "error"
          : res.statusCode >= 400
            ? "warn"
            : "info";
      logger[level](`${method} ${url} ${res.statusCode}`, {
        duration: `${duration}ms`,
      });
    });

    next();
  },
};

module.exports = logger;
