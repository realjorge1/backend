// ============================================
// FILE: services/documentProcessor.js
// Extracts text from uploaded files (PDF, DOCX, TXT)
// Compatible with express-fileupload file objects.
// ============================================
const { parsePDF: pdfParse } = require("../utils/pdfParser");
const fs = require("fs").promises;
const path = require("path");
const logger = require("../utils/logger");

class DocumentProcessor {
  /**
   * Extract text from an express-fileupload file object.
   * @param {object} file  express-fileupload file (has .tempFilePath, .mimetype, .name)
   * @returns {Promise<string>}
   */
  async extractText(file) {
    if (!file) throw new Error("No file provided");

    const filePath = file.tempFilePath;
    const mimeType = (file.mimetype || "").toLowerCase();
    const fileName = file.name || "";
    const ext = path.extname(fileName).toLowerCase();

    try {
      if (mimeType === "application/pdf" || ext === ".pdf") {
        return await this.extractPdfText(filePath);
      }

      if (
        mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        ext === ".docx"
      ) {
        return await this.extractDocxText(filePath);
      }

      if (mimeType === "application/epub+zip" || ext === ".epub") {
        return await this.extractEpubText(filePath);
      }

      if (
        mimeType.startsWith("text/") ||
        [".txt", ".md", ".csv", ".json", ".xml", ".html", ".htm"].includes(ext)
      ) {
        return await this.extractPlainText(filePath);
      }

      // Fallback: attempt plain text
      logger.warn(
        `Unknown file type "${mimeType}" (${ext}) — attempting plain text extraction`,
      );
      return await this.extractPlainText(filePath);
    } catch (err) {
      throw new Error(
        `Failed to extract text from "${fileName}": ${err.message}`,
      );
    }
  }

  async extractPdfText(filePath) {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    return data.text || "";
  }

  async extractDocxText(filePath) {
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || "";
    } catch (err) {
      if (err.code === "MODULE_NOT_FOUND") {
        throw new Error(
          'DOCX support requires the "mammoth" package. Run: npm install mammoth',
        );
      }
      throw err;
    }
  }

  async extractPlainText(filePath) {
    return await fs.readFile(filePath, "utf-8");
  }

  async extractEpubText(filePath) {
    try {
      const { extractEpubText: extractEpub } = require("./epubExtractor");
      const buffer = await fs.readFile(filePath);
      const { chapters } = await extractEpub(buffer);
      return chapters.map((ch) => ch.text).join("\n\n");
    } catch (err) {
      if (err.code === "MODULE_NOT_FOUND") {
        throw new Error(
          'EPUB support requires the "adm-zip" package. Run: npm install adm-zip',
        );
      }
      throw err;
    }
  }

  /**
   * Truncate text to a safe length.
   * @returns {{ text: string, wasTruncated: boolean }}
   */
  truncate(text, maxLength) {
    if (!text || text.length <= maxLength) {
      return { text: text || "", wasTruncated: false };
    }
    return {
      text:
        text.slice(0, maxLength) +
        "\n\n[Document truncated — exceeded maximum processing length]",
      wasTruncated: true,
    };
  }
}

module.exports = new DocumentProcessor();
