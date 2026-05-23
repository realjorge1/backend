const express = require("express");
const router = express.Router();
const pdfService = require("../services/pdfService");
const ocrService = require("../services/ocrService");
const { repairPdf } = require("../services/pdfRepairService");
const {
  encryptPDF,
  decryptPDF,
  isEncryptedPDFLabFile,
} = require("../services/pdfLabEncryption");
const fs = require("fs").promises;
const { outputPath, toDownloadUrl } = require("../utils/fileOutputUtils");

// ── Route-level request logging ──────────────────────────────────────────────
router.use((req, res, next) => {
  req._pdfStartTime = Date.now();
  const fileInfo = req.files
    ? Object.entries(req.files)
        .map(([k, v]) => {
          const files = Array.isArray(v) ? v : [v];
          return `${k}(${files.length} file${files.length > 1 ? "s" : ""}, ${files.map((f) => `${f.name}:${(f.size / 1024).toFixed(0)}KB`).join("+")})`;
        })
        .join(", ")
    : "no files";
  console.log(`[PDF] ▶ ${req.method} ${req.baseUrl}${req.path} | ${fileInfo}`);

  const origEnd = res.end.bind(res);
  res.end = function (...args) {
    const duration = Date.now() - req._pdfStartTime;
    console.log(
      `[PDF] ◀ ${req.method} ${req.baseUrl}${req.path} → ${res.statusCode} (${duration}ms)`,
    );
    return origEnd(...args);
  };

  next();
});

// Add text to PDF at specific position
router.post("/add-text", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const {
      text,
      pageNumber = 0,
      x = 50,
      y = 50,
      fontSize = 12,
      color = "0,0,0", // RGB format: "255,0,0" for red
    } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const resultPdf = await pdfService.addTextToPDF(req.files.pdf, {
      text,
      pageNumber: parseInt(pageNumber),
      x: parseInt(x),
      y: parseInt(y),
      fontSize: parseInt(fontSize),
      color,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=edited.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Add text error:", error);
    res.status(500).json({ error: error.message || "Failed to add text to PDF" });
  }
});

// Redact/Remove text (blackout sensitive information)
router.post("/redact", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { pageNumber = 0, x = 0, y = 0, width = 100, height = 20 } = req.body;

    const resultPdf = await pdfService.redactPDF(req.files.pdf, {
      pageNumber: parseInt(pageNumber),
      x: parseInt(x),
      y: parseInt(y),
      width: parseInt(width),
      height: parseInt(height),
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=redacted.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Redact error:", error);
    res.status(500).json({ error: error.message || "Failed to redact PDF" });
  }
});

// Merge PDFs
router.post("/merge", async (req, res) => {
  const startTime = Date.now();
  try {
    console.log("[PDF:merge] Request received", {
      hasFiles: !!req.files,
      fileFields: req.files ? Object.keys(req.files) : [],
    });

    if (!req.files || !req.files.pdfs) {
      // Check if files were sent with different field name
      if (req.files && Object.keys(req.files).length > 0) {
        return res.status(400).json({
          error: "Wrong field name",
          message:
            'Expected field name: "pdfs" for multiple files or "pdf" for single file',
          received: Object.keys(req.files),
        });
      }
      return res.status(400).json({
        error: "No files uploaded",
        message: "Please upload at least 2 PDF files to merge",
      });
    }

    const files = Array.isArray(req.files.pdfs)
      ? req.files.pdfs
      : [req.files.pdfs];

    if (files.length < 2) {
      return res.status(400).json({
        error: "Insufficient files",
        message: "Please upload at least 2 PDF files to merge",
      });
    }

    console.log(
      `[PDF:merge] Merging ${files.length} PDFs: ${files.map((f) => `${f.name}(${(f.size / 1024).toFixed(0)}KB)`).join(", ")}`,
    );
    const mergedPdf = await pdfService.mergePDFs(files);

    const duration = Date.now() - startTime;
    console.log(
      `[PDF:merge] ✅ Complete in ${duration}ms — output ${(mergedPdf.length / 1024).toFixed(0)}KB`,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=merged.pdf");
    res.setHeader("Content-Length", mergedPdf.length);
    res.setHeader("X-Processing-Time", `${duration}ms`);
    res.send(mergedPdf);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[PDF:merge] ❌ Failed after ${duration}ms:`, error.message);
    res.status(500).json({
      error: "Failed to merge PDFs",
      message: error.message,
    });
  }
});

// Split PDF
router.post("/split", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file",
      });
    }

    const { pageRanges } = req.body; // e.g., [[0,1,2], [3,4,5]]
    if (!pageRanges) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "pageRanges parameter is required",
      });
    }

    let ranges = JSON.parse(pageRanges);
    const splitAfterLastPoint = req.body.splitAfterLastPoint === "true";

    // If splitAfterLastPoint is set, append remaining pages as a final range
    if (splitAfterLastPoint && ranges.length > 0) {
      const pdfBytes = await fs.readFile(req.files.pdf.tempFilePath);
      const { safeLoadPDF } = require("../services/pdfService");
      const tmpDoc = await safeLoadPDF(pdfBytes, { ignoreEncryption: true });
      const totalPages = tmpDoc.getPageCount();

      // Find highest page index used in existing ranges
      let maxPage = -1;
      for (const range of ranges) {
        for (const p of range) {
          if (p > maxPage) maxPage = p;
        }
      }

      // Add remaining pages if any
      if (maxPage + 1 < totalPages) {
        const remaining = [];
        for (let p = maxPage + 1; p < totalPages; p++) remaining.push(p);
        ranges.push(remaining);
      }
    }

    console.log(`✂️  Splitting PDF into ${ranges.length} parts...`);

    // Derive a clean base name from the original file
    const origName = (req.files.pdf.name || "document")
      .replace(/\.pdf$/i, "")
      .replace(/[^\w\s-]/g, "")
      .trim() || "document";

    const splitPdfs = await pdfService.splitPDF(req.files.pdf, ranges);

    const duration = Date.now() - startTime;
    console.log(`✅ Split completed in ${duration}ms — ${splitPdfs.length} parts`);

    // Save each part as an individual PDF and return download URLs
    const files = [];
    for (let i = 0; i < splitPdfs.length; i++) {
      const filename = `${origName}_part_${i + 1}.pdf`;
      const outFile = outputPath(".pdf");
      await fs.writeFile(outFile, splitPdfs[i]);
      files.push({
        filename,
        url: toDownloadUrl(req, outFile),
        size: splitPdfs[i].length,
      });
    }

    return res.json({
      success: true,
      totalParts: files.length,
      files,
      processingTime: `${duration}ms`,
    });
  } catch (error) {
    console.error("❌ Split error:", error);
    res.status(500).json({
      error: "Failed to split PDF",
      message: error.message,
    });
  }
});

// Remove pages
router.post("/remove-pages", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file",
      });
    }

    const { pages } = req.body; // e.g., [0, 2, 4]
    if (!pages) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "pages parameter is required",
      });
    }

    const pagesToRemove = JSON.parse(pages);
    console.log(`🗑️  Removing ${pagesToRemove.length} pages...`);

    const resultPdf = await pdfService.removePages(
      req.files.pdf,
      pagesToRemove,
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Pages removed in ${duration}ms`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=removed-pages.pdf",
    );
    res.setHeader("X-Processing-Time", `${duration}ms`);
    res.send(resultPdf);
  } catch (error) {
    console.error("❌ Remove pages error:", error);
    res.status(500).json({
      error: "Failed to remove pages",
      message: error.message,
    });
  }
});

// Extract pages
router.post("/extract-pages", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file",
      });
    }

    const { pages } = req.body; // e.g., [0, 1, 3]
    if (!pages) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "pages parameter is required",
      });
    }

    const pagesToExtract = JSON.parse(pages);
    console.log(`📄 Extracting ${pagesToExtract.length} pages...`);

    const resultPdf = await pdfService.extractPages(
      req.files.pdf,
      pagesToExtract,
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Pages extracted in ${duration}ms`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=extracted-pages.pdf",
    );
    res.setHeader("X-Processing-Time", `${duration}ms`);
    res.send(resultPdf);
  } catch (error) {
    console.error("❌ Extract pages error:", error);
    res.status(500).json({
      error: "Failed to extract pages",
      message: error.message,
    });
  }
});

// Rotate PDF
router.post("/rotate", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file",
      });
    }

    const { rotation } = req.body; // 90, 180, or 270
    if (!rotation) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "rotation parameter is required (90, 180, or 270)",
      });
    }

    console.log(`🔄 Rotating PDF by ${rotation}°...`);
    const resultPdf = await pdfService.rotatePDF(
      req.files.pdf,
      parseInt(rotation),
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Rotation completed in ${duration}ms`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=rotated.pdf");
    res.setHeader("X-Processing-Time", `${duration}ms`);
    res.send(resultPdf);
  } catch (error) {
    console.error("❌ Rotate error:", error);
    res.status(500).json({
      error: "Failed to rotate PDF",
      message: error.message,
    });
  }
});

// Add watermark
router.post("/watermark", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file",
      });
    }

    const { text, fontSize, opacity } = req.body;
    if (!text) {
      return res.status(400).json({
        error: "Missing parameter",
        message: "text parameter is required for watermark",
      });
    }

    console.log(`💧 Adding watermark: "${text}"...`);
    const options = {
      fontSize: parseInt(fontSize) || 50,
      opacity: parseFloat(opacity) || 0.3,
    };

    const resultPdf = await pdfService.addWatermark(
      req.files.pdf,
      text,
      options,
    );

    const duration = Date.now() - startTime;
    console.log(`✅ Watermark added in ${duration}ms`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=watermarked.pdf",
    );
    res.setHeader("X-Processing-Time", `${duration}ms`);
    res.send(resultPdf);
  } catch (error) {
    console.error("❌ Watermark error:", error);
    res.status(500).json({
      error: "Failed to add watermark",
      message: error.message,
    });
  }
});

// Add page numbers
router.post("/page-numbers", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { position, alignment } = req.body;
    const options = {
      position: position || "bottom",
      alignment: alignment || "center",
    };

    const resultPdf = await pdfService.addPageNumbers(req.files.pdf, options);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=numbered.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Page numbers error:", error);
    res.status(500).json({ error: error.message || "Failed to add page numbers" });
  }
});

// Compress PDF
router.post("/compress", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file to compress",
      });
    }

    const { quality } = req.body; // 'low', 'medium', 'high'
    const originalSize = req.files.pdf.size;
    console.log(`🗜️  Compressing PDF (quality: ${quality || "medium"}, original: ${originalSize} bytes)...`);
    const resultPdf = await pdfService.compressPDF(
      req.files.pdf,
      quality || "medium",
    );

    const duration = Date.now() - startTime;
    const compressedSize = resultPdf.length;
    const reduction = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
    console.log(`✅ Compression completed in ${duration}ms — ${originalSize} → ${compressedSize} (${reduction}% reduction)`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=compressed.pdf");
    res.setHeader("Content-Length", String(compressedSize));
    res.setHeader("X-Processing-Time", `${duration}ms`);
    res.setHeader("X-Original-Size", String(originalSize));
    res.setHeader("X-Compressed-Size", String(compressedSize));
    res.setHeader("X-Compression-Reduction", `${reduction}%`);
    res.send(resultPdf);
  } catch (error) {
    console.error("❌ Compress error:", error);
    res.status(500).json({
      error: "Failed to compress PDF",
      message: error.message,
    });
  }
});

// Get PDF info
router.post("/info", async (req, res) => {
  const startTime = Date.now();
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({
        error: "No file uploaded",
        message: "Please upload a PDF file",
      });
    }

    console.log("📊 Getting PDF info...");
    const info = await pdfService.getPDFInfo(req.files.pdf);

    const duration = Date.now() - startTime;
    console.log(`✅ Info retrieved in ${duration}ms`);

    res.json({
      success: true,
      data: info,
      processingTime: `${duration}ms`,
    });
  } catch (error) {
    console.error("❌ PDF info error:", error);
    res.status(500).json({
      error: "Failed to get PDF info",
      message: error.message,
    });
  }
});

// Organize pages
router.post("/organize", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { pageOrder } = req.body;
    const order = JSON.parse(pageOrder);
    const resultPdf = await pdfService.organizePDF(req.files.pdf, order);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=organized.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Organize error:", error);
    res.status(500).json({ error: error.message || "Failed to organize PDF" });
  }
});

// Reverse pages
router.post("/reverse", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const resultPdf = await pdfService.reversePDF(req.files.pdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=reversed.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Reverse error:", error);
    res.status(500).json({ error: error.message || "Failed to reverse PDF" });
  }
});

// Duplicate pages
router.post("/duplicate", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { pages, duplicateAll } = req.body;
    let pagesToDuplicate;

    if (duplicateAll === "true" || duplicateAll === true) {
      // Duplicate all pages — service will handle it
      const pdfBytes = await fs.readFile(req.files.pdf.tempFilePath);
      const { PDFDocument: PDFDoc } = require("pdf-lib");
      const tmpPdf = await PDFDoc.load(pdfBytes);
      pagesToDuplicate = Array.from(
        { length: tmpPdf.getPageCount() },
        (_, i) => i,
      );
    } else if (pages) {
      pagesToDuplicate = JSON.parse(pages);
    } else {
      return res.status(400).json({
        error: "Missing parameter",
        message: "pages or duplicateAll parameter is required",
      });
    }

    const resultPdf = await pdfService.duplicatePDF(
      req.files.pdf,
      pagesToDuplicate,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=duplicated.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Duplicate error:", error);
    res.status(500).json({ error: error.message || "Failed to duplicate pages" });
  }
});

// Repair PDF (multi-strategy: qpdf → Ghostscript → pdf-lib)
router.post("/repair", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`🔧 Repairing PDF: ${req.files.pdf.name} (${req.files.pdf.size} bytes)`);
    const { buffer, strategy } = await repairPdf(req.files.pdf.tempFilePath);

    // Validate the repaired PDF is actually loadable
    const { PDFDocument: PDFDocCheck } = require("pdf-lib");
    const doc = await PDFDocCheck.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: false });
    const pageCount = doc.getPageCount();
    console.log(`✅ Repair succeeded via ${strategy} — ${pageCount} pages, ${buffer.length} bytes`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=repaired.pdf");
    res.setHeader("X-Repair-Strategy", strategy);
    res.setHeader("X-Page-Count", String(pageCount));
    res.send(buffer);
  } catch (error) {
    console.error("Repair error:", error);
    const isBeyondRecovery = error.message?.includes("beyond recovery");
    res.status(isBeyondRecovery ? 422 : 500).json({
      error: isBeyondRecovery
        ? "File is severely corrupted and cannot be repaired"
        : error.message || "Failed to repair PDF",
    });
  }
});

// Optimize images
router.post("/optimize-images", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { quality } = req.body;
    const originalSize = req.files.pdf.size;
    console.log(`🖼️  Optimizing images (quality: ${quality || 80}, original: ${originalSize} bytes)`);

    const resultPdf = await pdfService.optimizeImagesPDF(
      req.files.pdf,
      parseInt(quality) || 80,
    );

    const compressedSize = resultPdf.length;
    const reduction = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
    console.log(`✅ Image optimization done — ${originalSize} → ${compressedSize} (${reduction}% reduction)`);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=optimized.pdf");
    res.setHeader("X-Original-Size", String(originalSize));
    res.setHeader("X-Optimized-Size", String(compressedSize));
    res.setHeader("X-Reduction", `${reduction}%`);
    res.send(resultPdf);
  } catch (error) {
    console.error("Optimize images error:", error);
    res.status(500).json({ error: error.message || "Failed to optimize images" });
  }
});

// Remove duplicates
router.post("/remove-duplicates", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const resultPdf = await pdfService.removeDuplicatesPDF(req.files.pdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=no-duplicates.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Remove duplicates error:", error);
    res.status(500).json({ error: error.message || "Failed to remove duplicates" });
  }
});

// Protect PDF
router.post("/protect", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { password: rawPwd, permissions } = req.body;
    const password = (rawPwd || "").trim();
    console.log(
      `[DEBUG protect route] received | pwdLen=${password.length} ` +
        `hasSpace=${password.includes(" ")} ` +
        `startsWithUpper=${/^[A-Z]/.test(password)}`,
    );
    const resultPdf = await pdfService.protectPDF(
      req.files.pdf,
      password,
      permissions ? JSON.parse(permissions) : {},
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=protected.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Protect error:", error);
    res.status(500).json({ error: error.message || "Failed to protect PDF" });
  }
});

// Unlock PDF
router.post("/unlock", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { password: rawPassword } = req.body;
    if (!rawPassword) {
      return res
        .status(400)
        .json({ error: "Password is required to unlock PDF" });
    }
    const password = rawPassword.trim();
    console.log(
      `[DEBUG unlock route] received | pwdLen=${password.length} ` +
        `hasSpace=${password.includes(" ")} ` +
        `startsWithUpper=${/^[A-Z]/.test(password)}`,
    );

    const resultPdf = await pdfService.unlockPDF(req.files.pdf, password);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=unlocked.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Unlock error:", error);
    const msg = (error.message || "").toLowerCase();
    // Only report 400 (wrong password) when the error is specifically about
    // the password being incorrect — NOT for general decryption/format failures.
    const isWrongPassword =
      msg.includes("incorrect password") ||
      msg.includes("check your password") ||
      msg.includes("wrong password");
    if (isWrongPassword) {
      return res
        .status(400)
        .json({ error: "Incorrect password. Please try again." });
    }
    res.status(500).json({ error: error.message || "Failed to unlock PDF" });
  }
});

// ─── Encrypt PDF (Standard PDF AES-256 encryption) ──────────────────────────
router.post("/encrypt", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { password } = req.body;
    if (!password || password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }

    // Use the same standard PDF encryption as /protect (AES-256 via qpdf,
    // RC4-128 fallback).  This produces a universally compatible encrypted
    // PDF that any reader can open with the correct password.
    const resultPdf = await pdfService.protectPDF(
      req.files.pdf,
      password,
      {}, // default permissions
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=encrypted.pdf",
    );
    res.send(resultPdf);
  } catch (err) {
    console.error("[/api/pdf/encrypt]", err.message);
    return res
      .status(500)
      .json({ error: "Encryption failed.", detail: err.message });
  }
});

// ─── Decrypt encrypted file → PDF ────────────────────────────────────────────
// Handles both legacy .pdflab (AES-256-GCM) files and standard encrypted PDFs.
router.post("/decrypt", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: "Password is required." });
    }

    const fileBytes = await fs.readFile(req.files.pdf.tempFilePath);

    let pdfBytes;

    if (isEncryptedPDFLabFile(fileBytes)) {
      // Legacy .pdflab format — use AES-256-GCM decryption
      pdfBytes = await decryptPDF(fileBytes, password);
    } else {
      // Standard encrypted PDF — use the unlock pipeline
      // (qpdf → pdf-lib → built-in RC4 decryptor)
      pdfBytes = await pdfService.unlockPDF(req.files.pdf, password);
    }

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="decrypted.pdf"',
      "Content-Length": pdfBytes.length,
    });

    return res.send(pdfBytes);
  } catch (err) {
    console.error("[/api/pdf/decrypt]", err.message);

    if (err.message.startsWith("WRONG_PASSWORD_OR_CORRUPTED")) {
      return res
        .status(401)
        .json({ error: "Wrong password or corrupted file." });
    }
    if (err.message.startsWith("NOT_ENCRYPTED_FILE")) {
      return res
        .status(400)
        .json({ error: "This file is not encrypted." });
    }

    const msg = (err.message || "").toLowerCase();
    if (msg.includes("incorrect password") || msg.includes("wrong password") || msg.includes("check your password")) {
      return res.status(400).json({ error: "Incorrect password. Please try again." });
    }

    return res
      .status(500)
      .json({ error: "Decryption failed.", detail: err.message });
  }
});

// ─── Check if file is PDFLab-encrypted ───────────────────────────────────────
router.post("/check-encrypted", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const fileBytes = await fs.readFile(req.files.pdf.tempFilePath);
    const encrypted = isEncryptedPDFLabFile(fileBytes);
    return res.json({ encrypted });
  } catch (err) {
    console.error("[/api/pdf/check-encrypted]", err.message);
    return res
      .status(500)
      .json({ error: "Check failed.", detail: err.message });
  }
});

// Legacy header/footer (simple text only) — kept for backward compat.
// Enhanced version is at /api/header-footer with columns, tokens, logo, etc.
router.post("/header-footer", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { header, footer } = req.body;
    const resultPdf = await pdfService.addHeaderFooterPDF(
      req.files.pdf,
      header,
      footer,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=header-footer.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Header/Footer error:", error);
    res.status(500).json({ error: error.message || "Failed to add header/footer" });
  }
});

// Crop PDF
router.post("/crop", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { cropBox } = req.body;
    const resultPdf = await pdfService.cropPDF(
      req.files.pdf,
      JSON.parse(cropBox),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=cropped.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Crop error:", error);
    res.status(500).json({ error: error.message || "Failed to crop PDF" });
  }
});

// Resize PDF
router.post("/resize", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { width, height } = req.body;
    const resultPdf = await pdfService.resizePDF(
      req.files.pdf,
      parseInt(width),
      parseInt(height),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=resized.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Resize error:", error);
    res.status(500).json({ error: error.message || "Failed to resize PDF" });
  }
});

// Edit text
router.post("/edit-text", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { edits } = req.body;
    const resultPdf = await pdfService.editTextPDF(
      req.files.pdf,
      JSON.parse(edits),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=edited-text.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Edit text error:", error);
    res.status(500).json({ error: error.message || "Failed to edit text" });
  }
});

// Highlight
router.post("/highlight", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { highlights } = req.body;
    const resultPdf = await pdfService.highlightPDF(
      req.files.pdf,
      JSON.parse(highlights),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=highlighted.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Highlight error:", error);
    res.status(500).json({ error: error.message || "Failed to highlight" });
  }
});

// Annotate
router.post("/annotate", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { annotations, text, pages } = req.body;
    let parsedAnnotations;

    if (annotations) {
      parsedAnnotations = JSON.parse(annotations);
    } else if (text) {
      // Simple text annotation from frontend — use passed coordinates
      const annotX = parseFloat(req.body.x) || 50;
      const annotY = parseFloat(req.body.y) || 50;
      const bodyPage = req.body.pageNumber !== undefined ? parseInt(req.body.pageNumber, 10) : null;
      const targetPages = pages ? JSON.parse(pages) : (bodyPage !== null ? [bodyPage] : [0]);
      parsedAnnotations = targetPages.map((p) => ({
        pageNumber: p,
        text,
        x: annotX,
        y: annotY,
        type: "note",
      }));
    } else {
      return res.status(400).json({
        error: "Missing parameter",
        message: "annotations or text parameter is required",
      });
    }

    const resultPdf = await pdfService.annotatePDF(
      req.files.pdf,
      parsedAnnotations,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=annotated.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Annotate error:", error);
    res.status(500).json({ error: error.message || "Failed to annotate" });
  }
});

// Draw on PDF - Freehand drawing with paths
router.post("/draw", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { drawings } = req.body;
    // drawings format: [{ pageNumber, paths: [{ points: [{x, y}], color, strokeWidth }] }]
    const resultPdf = await pdfService.drawOnPDF(
      req.files.pdf,
      JSON.parse(drawings),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=drawn.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Draw error:", error);
    res.status(500).json({ error: error.message || "Failed to draw on PDF" });
  }
});

// Stamp
router.post("/stamp", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Accept both 'stamp' (text) and 'stampType' (preset)
    const stamp = req.body.stamp || req.body.stampType || "approved";
    const resultPdf = await pdfService.stampPDF(req.files.pdf, stamp);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=stamped.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Stamp error:", error);
    res.status(500).json({ error: error.message || "Failed to stamp PDF" });
  }
});

// Set metadata
router.post("/metadata", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { metadata } = req.body;
    const resultPdf = await pdfService.setMetadataPDF(
      req.files.pdf,
      JSON.parse(metadata),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=metadata.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Metadata error:", error);
    res.status(500).json({ error: error.message || "Failed to set metadata" });
  }
});

// Search in PDF
router.post("/search", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { query } = req.body;
    const results = await pdfService.searchPDF(req.files.pdf, query);

    res.json({ results });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: error.message || "Failed to search PDF" });
  }
});

// Validate PDF
router.post("/validate", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const validation = await pdfService.validatePDF(req.files.pdf);
    res.json(validation);
  } catch (error) {
    console.error("Validate error:", error);
    res.status(500).json({ error: error.message || "Failed to validate PDF" });
  }
});

// Fill form
router.post("/fill-form", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { data } = req.body;
    const parsedData = data ? JSON.parse(data) : {};
    const resultPdf = await pdfService.fillFormPDF(req.files.pdf, parsedData);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=filled-form.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Fill form error:", error);
    res.status(500).json({ error: error.message || "Failed to fill form" });
  }
});

// Flatten form
router.post("/flatten", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const resultPdf = await pdfService.flattenFormPDF(req.files.pdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=flattened.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Flatten error:", error);
    res.status(500).json({ error: error.message || "Failed to flatten form" });
  }
});

// Extract form data
router.post("/extract-data", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const result = await pdfService.extractFormDataPDF(req.files.pdf);
    res.json(result);
  } catch (error) {
    console.error("Extract form data error:", error);
    res.status(500).json({ error: error.message || "Failed to extract form data" });
  }
});

// Compare PDFs
router.post("/compare", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf1 || !req.files.pdf2) {
      return res.status(400).json({ error: "Two PDF files required" });
    }

    const differences = await pdfService.diffPDFs(
      req.files.pdf1,
      req.files.pdf2,
    );
    res.json(differences);
  } catch (error) {
    console.error("Compare error:", error);
    res.status(500).json({ error: error.message || "Failed to compare PDFs" });
  }
});

// Diff PDFs
router.post("/diff", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf1 || !req.files.pdf2) {
      return res.status(400).json({ error: "Two PDF files required" });
    }

    const differences = await pdfService.diffPDFs(
      req.files.pdf1,
      req.files.pdf2,
    );
    res.json(differences);
  } catch (error) {
    console.error("Diff error:", error);
    res.status(500).json({ error: error.message || "Failed to diff PDFs" });
  }
});

// Merge with review
router.post("/merge-review", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf1 || !req.files.pdf2) {
      return res.status(400).json({ error: "Two PDF files required" });
    }

    const resultPdf = await pdfService.mergeReviewPDFs(
      req.files.pdf1,
      req.files.pdf2,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=merged-review.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Merge review error:", error);
    res.status(500).json({ error: error.message || "Failed to merge with review" });
  }
});

// OCR - Extract text from scanned PDFs
router.post("/ocr", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { language, autoDetect } = req.body;
    let result;

    if (autoDetect === "true" || autoDetect === true) {
      result = await ocrService.extractTextWithAutoDetect(req.files.pdf);
    } else {
      result = await ocrService.extractTextFromPDF(
        req.files.pdf,
        language || "eng",
      );
    }

    res.json(result);
  } catch (error) {
    console.error("OCR error:", error);
    res.status(500).json({
      error: "Failed to perform OCR",
      details: error.message,
      hint: "Ensure Tesseract.js is installed: npm install tesseract.js",
    });
  }
});

// Get supported OCR languages
router.get("/ocr/languages", (req, res) => {
  res.json({
    languages: ocrService.getSupportedLanguages(),
    defaultLanguage: "eng",
  });
});

// Black and white
router.post("/black-white", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const resultPdf = await pdfService.blackWhitePDF(req.files.pdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=black-white.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Black/white error:", error);
    res.status(500).json({ error: error.message || "Failed to convert to black and white" });
  }
});

// Fix orientation
router.post("/fix-orientation", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const rotation = parseInt(req.body.rotation) || 90;
    // Parse page indices: accept JSON array of 0-based indices or comma-separated 1-based page numbers
    let pageIndices = null;
    if (req.body.pages) {
      try {
        const parsed = JSON.parse(req.body.pages);
        // Frontend sends 1-based page numbers — convert to 0-based
        pageIndices = Array.isArray(parsed)
          ? parsed.map((p) => p - 1)
          : null;
      } catch {
        // comma-separated fallback
        pageIndices = req.body.pages
          .split(",")
          .map((s) => parseInt(s.trim()) - 1)
          .filter((n) => !isNaN(n));
      }
    }

    const resultPdf = await pdfService.fixOrientationPDF(
      req.files.pdf,
      rotation,
      pageIndices,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=fixed-orientation.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Fix orientation error:", error);
    res.status(500).json({ error: error.message || "Failed to fix orientation" });
  }
});

// Remove blank pages
router.post("/remove-blank", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const resultPdf = await pdfService.removeBlankPagesPDF(req.files.pdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=no-blanks.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Remove blank error:", error);
    res.status(500).json({ error: error.message || "Failed to remove blank pages" });
  }
});

// Add bookmarks
router.post("/bookmarks", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { bookmarks } = req.body;
    const resultPdf = await pdfService.addBookmarksPDF(
      req.files.pdf,
      JSON.parse(bookmarks),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=bookmarked.pdf");
    res.send(resultPdf);
  } catch (error) {
    console.error("Bookmarks error:", error);
    res.status(500).json({ error: error.message || "Failed to add bookmarks" });
  }
});

// Add hyperlinks
router.post("/hyperlinks", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { links } = req.body;
    const resultPdf = await pdfService.addHyperlinksPDF(
      req.files.pdf,
      JSON.parse(links),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=hyperlinked.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Hyperlinks error:", error);
    res.status(500).json({ error: error.message || "Failed to add hyperlinks" });
  }
});

// Manage attachments
router.post("/attachments", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const attachments = req.files.files || [];
    const resultPdf = await pdfService.addAttachmentsPDF(
      req.files.pdf,
      attachments,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=with-attachments.pdf",
    );
    res.send(resultPdf);
  } catch (error) {
    console.error("Attachments error:", error);
    res.status(500).json({ error: error.message || "Failed to manage attachments" });
  }
});

// ────────────────────────────────────────────────────────────────────
// Enhanced PDF Repair (multi-strategy: qpdf → Ghostscript → pdf-lib)
// ────────────────────────────────────────────────────────────────────
router.post("/repair-enhanced", async (req, res) => {
  try {
    if (!req.files || !req.files.pdf) {
      return res.status(400).json({ error: "No PDF file uploaded" });
    }

    const file = req.files.pdf;
    const { buffer, strategy } = await repairPdf(file.tempFilePath);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=repaired.pdf");
    res.setHeader("X-Repair-Strategy", strategy);
    res.send(buffer);
  } catch (error) {
    console.error("Enhanced repair error:", error);
    res.status(500).json({
      error: "Failed to repair PDF",
      details: error.message,
    });
  }
});

module.exports = router;
