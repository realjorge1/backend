const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const PDFKit = require("pdfkit");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const sharp = require("sharp");
const { fromPath } = require("pdf2pic");

class ConvertService {
  // Convert image to PDF
  async imageToPDF(imageFile) {
    const pdfDoc = new PDFKit();
    const chunks = [];

    return new Promise(async (resolve, reject) => {
      pdfDoc.on("data", (chunk) => chunks.push(chunk));
      pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
      pdfDoc.on("error", reject);

      try {
        const imageBuffer = await fs.readFile(imageFile.tempFilePath);
        const image = await sharp(imageBuffer);
        const metadata = await image.metadata();

        // Fit image to page
        const maxWidth = 500;
        const maxHeight = 700;
        let width = metadata.width;
        let height = metadata.height;

        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = width * ratio;
          height = height * ratio;
        }

        pdfDoc.image(imageBuffer, {
          fit: [width, height],
          align: "center",
          valign: "center",
        });

        pdfDoc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Convert multiple images to PDF
  async imagesToPDF(imageFiles) {
    const pdfDoc = new PDFKit({ autoFirstPage: false });
    const chunks = [];

    return new Promise(async (resolve, reject) => {
      pdfDoc.on("data", (chunk) => chunks.push(chunk));
      pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
      pdfDoc.on("error", reject);

      try {
        for (const imageFile of imageFiles) {
          const imageBuffer = await fs.readFile(imageFile.tempFilePath);
          const image = await sharp(imageBuffer);
          const metadata = await image.metadata();

          pdfDoc.addPage({
            size: [metadata.width, metadata.height],
          });

          pdfDoc.image(imageBuffer, 0, 0, {
            fit: [metadata.width, metadata.height],
          });
        }

        pdfDoc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Convert text to PDF
  async textToPDF(text) {
    const pdfDoc = new PDFKit();
    const chunks = [];

    return new Promise((resolve, reject) => {
      pdfDoc.on("data", (chunk) => chunks.push(chunk));
      pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
      pdfDoc.on("error", reject);

      try {
        pdfDoc.fontSize(12);
        pdfDoc.text(text, {
          align: "left",
          width: 500,
        });

        pdfDoc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Convert HTML to PDF with basic formatting
  async htmlToPDF(html) {
    const pdfDoc = new PDFKit({
      size: "A4",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
    });
    const chunks = [];

    return new Promise((resolve, reject) => {
      pdfDoc.on("data", (chunk) => chunks.push(chunk));
      pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
      pdfDoc.on("error", reject);

      try {
        // Parse and render HTML with basic formatting
        let content = html;

        // Extract title
        const titleMatch = content.match(/<title[^>]*>(.*?)<\/title>/i);
        if (titleMatch) {
          pdfDoc.fontSize(24).font("Helvetica-Bold");
          pdfDoc.text(titleMatch[1], { align: "center" });
          pdfDoc.moveDown(2);
        }

        // Remove script and style tags
        content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
        content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

        // Handle headings
        content = content.replace(
          /<h1[^>]*>(.*?)<\/h1>/gi,
          "\n##H1##$1##/H1##\n",
        );
        content = content.replace(
          /<h2[^>]*>(.*?)<\/h2>/gi,
          "\n##H2##$1##/H2##\n",
        );
        content = content.replace(
          /<h3[^>]*>(.*?)<\/h3>/gi,
          "\n##H3##$1##/H3##\n",
        );

        // Handle paragraphs and line breaks
        content = content.replace(/<br\s*\/?>/gi, "\n");
        content = content.replace(/<\/p>/gi, "\n\n");
        content = content.replace(/<p[^>]*>/gi, "");

        // Handle lists
        content = content.replace(/<li[^>]*>/gi, "• ");
        content = content.replace(/<\/li>/gi, "\n");

        // Handle bold and italic
        content = content.replace(
          /<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi,
          "**$2**",
        );
        content = content.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, "_$2_");

        // Strip remaining HTML tags
        content = content.replace(/<[^>]*>/g, "");

        // Decode HTML entities
        content = content.replace(/&nbsp;/g, " ");
        content = content.replace(/&amp;/g, "&");
        content = content.replace(/&lt;/g, "<");
        content = content.replace(/&gt;/g, ">");
        content = content.replace(/&quot;/g, '"');
        content = content.replace(/&#39;/g, "'");

        // Clean up whitespace
        content = content.replace(/\n{3,}/g, "\n\n");
        content = content.trim();

        // Render content with formatting
        const lines = content.split("\n");
        for (const line of lines) {
          if (line.includes("##H1##")) {
            const text = line.replace(/##H1##|##\/H1##/g, "").trim();
            pdfDoc.fontSize(20).font("Helvetica-Bold");
            pdfDoc.text(text);
            pdfDoc.moveDown(0.5);
          } else if (line.includes("##H2##")) {
            const text = line.replace(/##H2##|##\/H2##/g, "").trim();
            pdfDoc.fontSize(16).font("Helvetica-Bold");
            pdfDoc.text(text);
            pdfDoc.moveDown(0.3);
          } else if (line.includes("##H3##")) {
            const text = line.replace(/##H3##|##\/H3##/g, "").trim();
            pdfDoc.fontSize(14).font("Helvetica-Bold");
            pdfDoc.text(text);
            pdfDoc.moveDown(0.2);
          } else if (line.trim()) {
            pdfDoc.fontSize(12).font("Helvetica");
            pdfDoc.text(line.trim(), { width: 500 });
          } else {
            pdfDoc.moveDown(0.5);
          }
        }

        pdfDoc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Convert PDF to images
  async pdfToImages(pdfFile, format = "png") {
    const inputPath = pdfFile.tempFilePath;
    console.log(`[convert] pdfToImages: format=${format}`);

    // Primary: mupdf WebAssembly renderer — no system dependencies required
    try {
      const images = await this._pdfToImagesViaMupdf(inputPath, format);
      if (images.length > 0) {
        console.log(`[convert] pdfToImages (mupdf): ${images.length} page(s)`);
        return images;
      }
      throw new Error("mupdf returned 0 pages");
    } catch (mupdfErr) {
      console.warn(`[convert] mupdf failed (${mupdfErr.message}), trying pdf2pic…`);
    }

    // Fallback: pdf2pic — works when GraphicsMagick / Ghostscript is installed
    try {
      const images = await this._pdfToImagesViaPdf2Pic(inputPath, format);
      if (images.length > 0) {
        console.log(`[convert] pdfToImages (pdf2pic): ${images.length} page(s)`);
        return images;
      }
      throw new Error("pdf2pic returned 0 pages");
    } catch (pdf2picErr) {
      console.error(`[convert] pdf2pic also failed: ${pdf2picErr.message}`);
      throw new Error(
        "PDF to image conversion failed. " +
          "The server could not render PDF pages to images. " +
          "Details: " + pdf2picErr.message,
      );
    }
  }

  // mupdf-based renderer (WebAssembly, no native deps)
  async _pdfToImagesViaMupdf(inputPath, format) {
    const mupdf = await import("mupdf");
    const pdfBuffer = await fs.readFile(inputPath);

    const doc = mupdf.Document.openDocument(
      new Uint8Array(pdfBuffer),
      "application/pdf",
    );
    const pageCount = doc.countPages();
    if (pageCount === 0) throw new Error("PDF has no pages");

    const scale = 150 / 72; // 150 DPI render
    const images = [];

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const matrix = mupdf.Matrix.scale(scale, scale);
      const pixmap = page.toPixmap(
        matrix,
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );

      let buf = Buffer.from(pixmap.asPNG());

      // Convert PNG → JPEG if requested
      if (format === "jpg" || format === "jpeg") {
        buf = await sharp(buf).jpeg({ quality: 85 }).toBuffer();
      }

      if (!buf || buf.length === 0) {
        throw new Error(`Empty image for page ${i + 1}`);
      }
      images.push(buf);
    }

    return images;
  }

  // pdf2pic-based renderer (needs GraphicsMagick or Ghostscript)
  async _pdfToImagesViaPdf2Pic(inputPath, format) {
    const pdfBuffer = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();

    const options = {
      density: 150,
      saveFilename: "page",
      savePath: path.dirname(inputPath),
      format,
      width: 1654,
      height: 2339,
    };

    const convert = fromPath(inputPath, options);
    const images = [];

    for (let i = 1; i <= pageCount; i++) {
      const result = await convert(i, { responseType: "buffer" });
      const buf = result.buffer || result;
      if (!buf || buf.length === 0) {
        throw new Error(`Empty buffer from pdf2pic for page ${i}`);
      }
      images.push(buf);
    }

    return images;
  }

  // Convert PDF to text
  async pdfToText(pdfFile) {
    const { parsePDF } = require("../utils/pdfParser");
    const dataBuffer = await fs.readFile(pdfFile.tempFilePath);
    const data = await parsePDF(dataBuffer);
    return data.text;
  }

  // Convert PDF to HTML with structured output
  async pdfToHTML(pdfFile) {
    const { parsePDF } = require("../utils/pdfParser");
    const pdfService = require("./pdfService");
    const dataBuffer = await pdfService.readFileBytes(pdfFile);

    // Validate magic bytes — parsePDF crashes obscurely on non-PDF input.
    if (dataBuffer.length < 5 || dataBuffer.slice(0, 5).toString("binary") !== "%PDF-") {
      const head = dataBuffer.slice(0, 4).toString("hex");
      if (head === "504b0304") {
        throw new Error("This file is a ZIP-based document (DOCX/EPUB/XLSX), not a PDF.");
      }
      throw new Error("This file is not a valid PDF and cannot be opened for editing.");
    }

    let data;
    try {
      data = await parsePDF(dataBuffer);
    } catch (err) {
      throw new Error(
        "Could not extract text from this PDF. It may be encrypted, scanned, or corrupted: " +
          (err.message || "unknown error"),
      );
    }

    if (!data?.text || !data.text.trim()) {
      throw new Error(
        "No editable text found in this PDF. Scanned or image-only PDFs need OCR before editing.",
      );
    }

    // Process text into paragraphs
    const paragraphs = data.text
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const bodyContent = paragraphs
      .map(
        (p) =>
          `    <p>${p.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`,
      )
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Converted PDF - ${data.info?.Title || "Document"}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            padding: 40px 20px;
            max-width: 800px;
            margin: 0 auto;
            color: #333;
            background: #fff;
        }
        h1 { font-size: 24px; margin-bottom: 20px; color: #111; }
        p { margin-bottom: 16px; text-align: justify; }
        .meta { color: #666; font-size: 14px; margin-bottom: 30px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
    </style>
</head>
<body>
    <div class="meta">
        <strong>Pages:</strong> ${data.numpages} | 
        <strong>Characters:</strong> ${data.text.length.toLocaleString()}
        ${data.info?.Author ? ` | <strong>Author:</strong> ${data.info.Author}` : ""}
    </div>
${bodyContent}
</body>
</html>`;

    return Buffer.from(html, "utf-8");
  }
}

module.exports = new ConvertService();
