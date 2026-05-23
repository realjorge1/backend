const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const PDFKit = require("pdfkit");
const { PDFDocument } = require("pdf-lib");

// UUID format validation to prevent path traversal
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateDocId(docId) {
  if (!docId || !UUID_REGEX.test(docId)) {
    throw new Error("Invalid document ID");
  }
}

class DocumentService {
  constructor() {
    this.documentsDir = path.join(__dirname, "../../uploads/documents");
    this.initializeStorage();
  }

  async initializeStorage() {
    try {
      await fs.mkdir(this.documentsDir, { recursive: true });
    } catch (error) {
      console.error("Failed to create documents directory:", error);
    }
  }

  // Create a new document
  async createDocument(type, template, title, content) {
    const docId = uuidv4();
    const timestamp = new Date().toISOString();

    let fileBuffer;
    let fileName;
    let mimeType;

    switch (type.toLowerCase()) {
      case "pdf":
        fileBuffer = await this.createPDFDocument(title, content, template);
        fileName = `${docId}.pdf`;
        mimeType = "application/pdf";
        break;

      case "docx":
      case "word":
        // Placeholder - would need docx library
        throw new Error(
          "DOCX creation requires additional library (officegen or docx)",
        );

      case "xlsx":
      case "excel":
        // Placeholder - would need xlsx library
        throw new Error("XLSX creation requires additional library (exceljs)");

      case "pptx":
      case "powerpoint":
        // Placeholder - would need pptx library
        throw new Error(
          "PPTX creation requires additional library (pptxgenjs)",
        );

      default:
        throw new Error(`Unsupported document type: ${type}`);
    }

    // Save the file
    const filePath = path.join(this.documentsDir, fileName);
    await fs.writeFile(filePath, fileBuffer);

    // Create metadata
    const metadata = {
      id: docId,
      title: title || "Untitled Document",
      type,
      template,
      fileName,
      filePath,
      mimeType,
      createdAt: timestamp,
      updatedAt: timestamp,
      fileUrl: `/api/document/file/${docId}`,
    };

    // Save metadata
    const metadataPath = path.join(this.documentsDir, `${docId}.json`);
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return metadata;
  }

  // Create PDF document with content
  async createPDFDocument(title, content, template) {
    return new Promise((resolve, reject) => {
      const pdfDoc = new PDFKit();
      const chunks = [];

      pdfDoc.on("data", (chunk) => chunks.push(chunk));
      pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
      pdfDoc.on("error", reject);

      try {
        // Add title
        pdfDoc.fontSize(24).text(title || "New Document", {
          align: "center",
        });

        pdfDoc.moveDown();

        // Add content based on template
        if (template === "blank") {
          pdfDoc.fontSize(12).text(content || "This is a blank document.");
        } else if (template === "letter") {
          pdfDoc.fontSize(12);
          pdfDoc.text(new Date().toLocaleDateString(), { align: "right" });
          pdfDoc.moveDown();
          pdfDoc.text("Dear [Recipient],");
          pdfDoc.moveDown();
          pdfDoc.text(content || "Letter content goes here...");
          pdfDoc.moveDown();
          pdfDoc.text("Sincerely,");
          pdfDoc.text("[Your Name]");
        } else if (template === "report") {
          pdfDoc.fontSize(18).text("Executive Summary", { underline: true });
          pdfDoc.moveDown();
          pdfDoc.fontSize(12).text(content || "Report content goes here...");
        } else if (template === "invoice") {
          pdfDoc.fontSize(18).text("INVOICE", { align: "center" });
          pdfDoc.moveDown();
          pdfDoc.fontSize(12);
          pdfDoc.text(`Invoice #: ${Date.now()}`);
          pdfDoc.text(`Date: ${new Date().toLocaleDateString()}`);
          pdfDoc.moveDown();
          pdfDoc.text(content || "Invoice items go here...");
        } else {
          pdfDoc.fontSize(12).text(content || "Document content...");
        }

        pdfDoc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // List all documents
  async listDocuments() {
    try {
      const files = await fs.readdir(this.documentsDir);
      const metadataFiles = files.filter((f) => f.endsWith(".json"));

      const documents = [];
      for (const metaFile of metadataFiles) {
        try {
          const metaPath = path.join(this.documentsDir, metaFile);
          const metaContent = await fs.readFile(metaPath, "utf-8");
          documents.push(JSON.parse(metaContent));
        } catch (error) {
          console.error(`Error reading metadata ${metaFile}:`, error);
        }
      }

      // Sort by creation date (newest first)
      documents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return documents;
    } catch (error) {
      console.error("Error listing documents:", error);
      return [];
    }
  }

  // Get a specific document
  async getDocument(docId) {
    validateDocId(docId);
    try {
      const metadataPath = path.join(this.documentsDir, `${docId}.json`);
      const resolved = path.resolve(metadataPath);
      if (!resolved.startsWith(path.resolve(this.documentsDir))) {
        throw new Error("Invalid document ID");
      }
      const metaContent = await fs.readFile(metadataPath, "utf-8");
      return JSON.parse(metaContent);
    } catch (error) {
      throw new Error("Document not found");
    }
  }

  // Get document file
  async getDocumentFile(docId) {
    const metadata = await this.getDocument(docId);
    const fileBuffer = await fs.readFile(metadata.filePath);
    return { buffer: fileBuffer, metadata };
  }

  // Delete a document
  async deleteDocument(docId) {
    try {
      const metadata = await this.getDocument(docId);

      // Delete the file
      await fs.unlink(metadata.filePath);

      // Delete the metadata
      const metadataPath = path.join(this.documentsDir, `${docId}.json`);
      await fs.unlink(metadataPath);

      return { success: true, message: "Document deleted successfully" };
    } catch (error) {
      throw new Error("Failed to delete document");
    }
  }

  // Update document metadata
  async updateDocument(docId, updates) {
    validateDocId(docId);
    try {
      const metadata = await this.getDocument(docId);

      // Allowlist only safe fields to prevent overwriting id, filePath, etc.
      const { title, content, template } = updates;
      const updatedMetadata = {
        ...metadata,
        ...(title !== undefined && { title }),
        ...(content !== undefined && { content }),
        ...(template !== undefined && { template }),
        updatedAt: new Date().toISOString(),
      };

      const metadataPath = path.join(this.documentsDir, `${docId}.json`);
      await fs.writeFile(
        metadataPath,
        JSON.stringify(updatedMetadata, null, 2),
      );

      return updatedMetadata;
    } catch (error) {
      throw new Error("Failed to update document");
    }
  }
}

module.exports = new DocumentService();
