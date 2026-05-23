const Tesseract = require("tesseract.js");
const fs = require("fs").promises;
const { fromPath } = require("pdf2pic");
const path = require("path");

class OCRService {
  constructor() {
    this.supportedLanguages = [
      "eng",
      "spa",
      "fra",
      "deu",
      "ita",
      "por",
      "rus",
      "chi_sim",
      "jpn",
      "kor",
    ];
  }

  /**
   * Extract text from image using Tesseract.js
   */
  async extractTextFromImage(imageBuffer, language = "eng") {
    try {
      const result = await Tesseract.recognize(imageBuffer, language, {
        logger: () => {}, // Suppress verbose progress logging
      });

      return {
        text: result.data.text,
        confidence: result.data.confidence,
        words: result.data.words.length,
        lines: result.data.lines.length,
      };
    } catch (error) {
      console.error("OCR error:", error);
      throw new Error("Failed to extract text from image");
    }
  }

  /**
   * Extract text from PDF by converting to images first
   */
  async extractTextFromPDF(pdfFile, language = "eng") {
    try {
      // Convert PDF pages to images
      const options = {
        density: 300, // Higher density = better quality
        saveFilename: `ocr_${Date.now()}`,
        savePath: path.dirname(pdfFile.tempFilePath),
        format: "png",
        width: 2000,
        height: 2000,
      };

      const convert = fromPath(pdfFile.tempFilePath, options);

      // Get PDF page count
      const { parsePDF } = require("../utils/pdfParser");
      const dataBuffer = await fs.readFile(pdfFile.tempFilePath);
      const data = await parsePDF(dataBuffer);
      const pageCount = data.numpages;

      let fullText = "";
      const pageResults = [];

      // Process each page
      for (let i = 1; i <= pageCount; i++) {
        try {
          // Convert page to image
          const pageImage = await convert(i, { responseType: "buffer" });
          const imageBuffer = pageImage.buffer || pageImage;

          // Extract text from image
          const result = await this.extractTextFromImage(imageBuffer, language);

          fullText += `\n--- Page ${i} ---\n${result.text}\n`;

          pageResults.push({
            page: i,
            text: result.text,
            confidence: result.confidence,
            words: result.words,
            lines: result.lines,
          });
        } catch (error) {
          console.error(`Error processing page ${i}:`, error);
          pageResults.push({
            page: i,
            error: "Failed to process page",
          });
        }
      }

      return {
        text: fullText.trim(),
        pages: pageResults,
        totalPages: pageCount,
        language: language,
      };
    } catch (error) {
      console.error("PDF OCR error:", error);
      throw new Error("Failed to perform OCR on PDF");
    }
  }

  /**
   * Extract text with automatic language detection.
   * Samples the first page to detect the best language, then runs
   * full OCR with that language — instead of running entire document 4×.
   */
  async extractTextWithAutoDetect(pdfFile) {
    const languages = ["eng", "spa", "fra", "deu"];
    let bestLang = "eng";
    let highestConfidence = 0;

    // Step 1: Sample first page with each language to detect best one
    const { parsePDF } = require("../utils/pdfParser");
    const dataBuffer = await fs.readFile(pdfFile.tempFilePath);
    const data = await parsePDF(dataBuffer);
    if (data.numpages > 0) {
      const options = {
        density: 300,
        saveFilename: `langdet_${Date.now()}`,
        savePath: path.dirname(pdfFile.tempFilePath),
        format: "png",
        width: 2000,
        height: 2000,
      };
      const convert = fromPath(pdfFile.tempFilePath, options);
      try {
        const pageImage = await convert(1, { responseType: "buffer" });
        const imageBuffer = pageImage.buffer || pageImage;

        for (const lang of languages) {
          try {
            const result = await this.extractTextFromImage(imageBuffer, lang);
            if (result.confidence > highestConfidence) {
              highestConfidence = result.confidence;
              bestLang = lang;
            }
          } catch (_) {
            /* skip */
          }
        }
      } catch (_) {
        /* fallback to eng */
      }
    }

    // Step 2: Run full OCR once with the best detected language
    const result = await this.extractTextFromPDF(pdfFile, bestLang);
    result.detectedLanguage = bestLang;
    return result;
  }

  /**
   * Get supported languages
   */
  getSupportedLanguages() {
    return this.supportedLanguages;
  }
}

module.exports = new OCRService();
