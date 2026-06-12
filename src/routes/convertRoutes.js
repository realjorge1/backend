const express = require("express");
const router = express.Router();
const convertService = require("../services/convertService");
const officeConversionService = require("../services/officeConversionService");
const archiver = require("archiver");
const fsAsync = require("fs").promises;

// Images to PDF
router.post("/images-to-pdf", async (req, res) => {
  try {
    if (!req.files || !req.files.images) {
      return res.status(400).json({ error: "No images uploaded" });
    }

    const files = Array.isArray(req.files.images)
      ? req.files.images
      : [req.files.images];
    const resultPdf = await convertService.imagesToPDF(files);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=images.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Images to PDF error:", error);
    res.status(500).json({ error: error.message || "Failed to convert images to PDF" });
  }
});

// JPG to PDF
router.post("/jpg-to-pdf", async (req, res) => {
  try {
    if (!req.files || !req.files.image) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const resultPdf = await convertService.imageToPDF(req.files.image);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("JPG to PDF error:", error);
    res.status(500).json({ error: error.message || "Failed to convert JPG to PDF" });
  }
});

// PNG to PDF
router.post("/png-to-pdf", async (req, res) => {
  try {
    if (!req.files || !req.files.image) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const resultPdf = await convertService.imageToPDF(req.files.image);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("PNG to PDF error:", error);
    res.status(500).json({ error: error.message || "Failed to convert PNG to PDF" });
  }
});

// Text to PDF
router.post("/text-to-pdf", async (req, res) => {
  try {
    let text = req.body?.text;

    // If no text in body, check for uploaded file
    if (!text && req.files && req.files.file) {
      const fileData = req.files.file;
      text = await fsAsync.readFile(fileData.tempFilePath, "utf-8");
    }

    if (!text) {
      return res.status(400).json({ error: "No text provided" });
    }

    const resultPdf = await convertService.textToPDF(text);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=text.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Text to PDF error:", error);
    res.status(500).json({ error: error.message || "Failed to convert text to PDF" });
  }
});

// HTML to PDF
router.post("/html-to-pdf", async (req, res) => {
  try {
    let html = req.body?.html;

    // If no html in body, check for uploaded file
    if (!html && req.files && req.files.file) {
      const fileData = req.files.file;
      html = await fsAsync.readFile(fileData.tempFilePath, "utf-8");
    }

    if (!html) {
      return res.status(400).json({ error: "No HTML provided" });
    }

    const resultPdf = await convertService.htmlToPDF(html);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=html.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("HTML to PDF error:", error);
    res.status(500).json({ error: error.message || "Failed to convert HTML to PDF" });
  }
});

// Word to PDF
router.post("/word-to-pdf", async (req, res) => {
  try {
    if (!req.files || !req.files.document) {
      return res.status(400).json({ error: "No document uploaded" });
    }

    const resultPdf = await officeConversionService.wordToPDF(
      req.files.document,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Word to PDF error:", error);
    res.status(error.statusCode || 500).json({
      error: "Failed to convert Word to PDF",
      details: error.message,
      hint: "Ensure LibreOffice is installed on the server",
    });
  }
});

// PowerPoint to PDF
router.post("/ppt-to-pdf", async (req, res) => {
  try {
    if (!req.files || !req.files.document) {
      return res.status(400).json({ error: "No document uploaded" });
    }

    const resultPdf = await officeConversionService.pptToPDF(
      req.files.document,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("PowerPoint to PDF error:", error);
    res.status(error.statusCode || 500).json({
      error: "Failed to convert PowerPoint to PDF",
      code: error.code || "INTERNAL_ERROR",
      details: error.message,
      hint: "Ensure LibreOffice is installed on the server",
    });
  }
});

// Excel to PDF
router.post("/excel-to-pdf", async (req, res) => {
  try {
    if (!req.files || !req.files.document) {
      return res.status(400).json({ error: "No document uploaded" });
    }

    const resultPdf = await officeConversionService.excelToPDF(
      req.files.document,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=converted.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Excel to PDF error:", error);
    res.status(error.statusCode || 500).json({
      error: "Failed to convert Excel to PDF",
      details: error.message,
      hint: "Ensure LibreOffice is installed on the server",
    });
  }
});

// PDF to JPG — always returns a single image (page 1, or page specified by ?page=N)
router.post("/pdf-to-jpg", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const page = Math.max(1, parseInt(req.body.page, 10) || 1);
    const images = await convertService.pdfToImages(req.files.pdf, "jpg");
    const image = images[page - 1] ?? images[0];
    if (!image) {
      return res.status(500).json({ error: "No image generated" });
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", `attachment; filename=page-${page}.jpg`);
    res.send(image);
  } catch (error) {
    console.error("PDF to JPG error:", error);
    res.status(500).json({ error: error.message || "Failed to convert PDF to JPG" });
  }
});

// PDF to PNG — always returns a single image (page 1, or page specified by ?page=N)
router.post("/pdf-to-png", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const page = Math.max(1, parseInt(req.body.page, 10) || 1);
    const images = await convertService.pdfToImages(req.files.pdf, "png");
    const image = images[page - 1] ?? images[0];
    if (!image) {
      return res.status(500).json({ error: "No image generated" });
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename=page-${page}.png`);
    res.send(image);
  } catch (error) {
    console.error("PDF to PNG error:", error);
    res.status(500).json({ error: error.message || "Failed to convert PDF to PNG" });
  }
});

// PDF to Text
router.post("/pdf-to-text", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const text = await convertService.pdfToText(req.files.pdf);

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", "attachment; filename=converted.txt");
    res.send(text);
  } catch (error) {
    console.error("PDF to text error:", error);
    res.status(500).json({ error: error.message || "Failed to convert PDF to text" });
  }
});

// PDF to HTML
router.post("/pdf-to-html", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const html = await convertService.pdfToHTML(req.files.pdf);

    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Disposition", "attachment; filename=converted.html");
    res.send(html);
  } catch (error) {
    console.error("PDF to HTML error:", error);
    res.status(500).json({ error: error.message || "Failed to convert PDF to HTML" });
  }
});

// PDF to Word
router.post("/pdf-to-word", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const resultDocx = await officeConversionService.pdfToWord(req.files.pdf);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader("Content-Disposition", "attachment; filename=converted.docx");
    res.send(resultDocx);
  } catch (error) {
    console.error("PDF to Word error:", error);
    res.status(500).json({
      error: "Failed to convert PDF to Word",
      details: error.message,
      hint: "Install pdf2docx: pip install pdf2docx",
    });
  }
});

// PDF to PowerPoint
router.post("/pdf-to-ppt", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const resultPptx = await officeConversionService.pdfToPPT(req.files.pdf);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    res.setHeader("Content-Disposition", "attachment; filename=converted.pptx");
    res.send(resultPptx);
  } catch (error) {
    console.error("PDF to PPT error:", error);
    res.status(500).json({
      error: "Failed to convert PDF to PowerPoint",
      details: error.message,
      hint: "This feature requires pdf2image and python-pptx: pip install pdf2image python-pptx",
    });
  }
});

// PDF to Excel
router.post("/pdf-to-excel", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    const resultXlsx = await officeConversionService.pdfToExcel(req.files.pdf);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", "attachment; filename=converted.xlsx");
    res.send(resultXlsx);
  } catch (error) {
    console.error("PDF to Excel error:", error);
    res.status(500).json({
      error: "Failed to convert PDF to Excel",
      details: error.message,
      hint: "Install tabula-py: pip install tabula-py pandas openpyxl",
    });
  }
});

module.exports = router;
