const express = require("express");
const router = express.Router();
const documentService = require("../services/documentService");
const reflowService = require("../services/reflowService");

// Create a new document
router.post("/create", async (req, res) => {
  try {
    const { type, template, title, content } = req.body;

    if (!type) {
      return res.status(400).json({ error: "Document type is required" });
    }

    const document = await documentService.createDocument(
      type,
      template || "blank",
      title || "Untitled Document",
      content || "",
    );

    res.json(document);
  } catch (error) {
    console.error("Create document error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to create document" });
  }
});

// List all documents
router.get("/list", async (req, res) => {
  try {
    const documents = await documentService.listDocuments();
    res.json({ documents });
  } catch (error) {
    console.error("List documents error:", error);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

// Get a specific document (metadata)
router.get("/get/:id", async (req, res) => {
  try {
    const document = await documentService.getDocument(req.params.id);
    res.json(document);
  } catch (error) {
    console.error("Get document error:", error);
    res.status(404).json({ error: "Document not found" });
  }
});

// Get document file (download)
router.get("/file/:id", async (req, res) => {
  try {
    const { buffer, metadata } = await documentService.getDocumentFile(
      req.params.id,
    );

    res.setHeader("Content-Type", metadata.mimeType);
    // Properly escape filename to prevent header injection
    const safeName = metadata.fileName.replace(/["\\\r\n]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(buffer);
  } catch (error) {
    console.error("Get document file error:", error);
    res.status(404).json({ error: "Document not found" });
  }
});

// Update document metadata
router.put("/update/:id", async (req, res) => {
  try {
    const updates = req.body;
    const document = await documentService.updateDocument(
      req.params.id,
      updates,
    );
    res.json(document);
  } catch (error) {
    console.error("Update document error:", error);
    res.status(500).json({ error: "Failed to update document" });
  }
});

// Delete a document
router.delete("/delete/:id", async (req, res) => {
  try {
    const result = await documentService.deleteDocument(req.params.id);
    res.json(result);
  } catch (error) {
    console.error("Delete document error:", error);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

module.exports = router;

// ============================================================================
// REFLOW ENDPOINTS — Mobile View text extraction & HTML generation
// ============================================================================

/**
 * POST /api/document/pdf-reflow
 * Expects a PDF file upload (field: "file") and optional body params:
 *   fontSize, lineHeight, theme, fontFamily
 * Returns: { success, html, plainText, metadata } or error
 */
router.post("/pdf-reflow", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.files.file;
    const buffer = file.data?.length ? file.data : require("fs").readFileSync(file.tempFilePath);
    const options = {
      fontSize: parseInt(req.body.fontSize) || 16,
      lineHeight: parseFloat(req.body.lineHeight) || 1.6,
      theme: req.body.theme || "light",
      fontFamily: req.body.fontFamily || "system-ui",
    };

    const result = await reflowService.reflowPDF(buffer, file.name, options);

    if (!result.success) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error("PDF reflow error:", error);
    res.status(500).json({
      error: error.message || "Failed to process PDF for mobile view",
    });
  }
});

/**
 * POST /api/document/docx-reflow
 * Expects a DOCX file upload (field: "file") and optional body params:
 *   fontSize, lineHeight, theme, fontFamily
 * Returns: { success, html, plainText, metadata } or error
 */
router.post("/docx-reflow", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.files.file;
    const buffer = file.data?.length ? file.data : require("fs").readFileSync(file.tempFilePath);
    const options = {
      fontSize: parseInt(req.body.fontSize) || 16,
      lineHeight: parseFloat(req.body.lineHeight) || 1.6,
      theme: req.body.theme || "light",
      fontFamily: req.body.fontFamily || "system-ui",
    };

    const result = await reflowService.reflowDOCX(buffer, file.name, options);

    if (!result.success) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error("DOCX reflow error:", error);
    res.status(500).json({
      error: error.message || "Failed to process DOCX for mobile view",
    });
  }
});

/**
 * POST /api/document/extract-text
 * Expects a PDF file upload (field: "file")
 * Returns: { text, pageCount, hasText }
 */
router.post("/extract-text", async (req, res) => {
  try {
    if (!req.files || !req.files.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const file = req.files.file;
    const buffer = file.data?.length ? file.data : require("fs").readFileSync(file.tempFilePath);
    const result = await reflowService.extractPDFText(buffer);
    res.json(result);
  } catch (error) {
    console.error("Text extraction error:", error);
    res.status(500).json({ error: error.message || "Failed to extract text" });
  }
});
