/**
 * Signing Routes
 * Express router exposing all PDF signing endpoints.
 *
 * POST /api/signing/visual       — Visual/annotation signature
 * POST /api/signing/digital      — Cryptographic digital signature
 * POST /api/signing/verify       — Verify existing signatures
 * POST /api/signing/cert-info    — Parse certificate and return metadata
 */

const express = require("express");
const router = express.Router();

const { embedVisualSignature } = require("../services/pdfAppearanceService");
const { signPdfDigitally } = require("../services/pdfDigitalSigningService");
const {
  verifyPdfSignatures,
} = require("../services/signatureVerificationService");
const {
  parseCertificate,
  validateCertificateValidity,
} = require("../services/certificateService");

/**
 * Helper: get file buffer from express-fileupload file object.
 * express-fileupload provides `data` (Buffer) directly, or `tempFilePath`.
 */
function getFileBuffer(file) {
  if (file.data && file.data.length > 0) return file.data;
  if (file.tempFilePath) return require("fs").readFileSync(file.tempFilePath);
  throw new Error("Cannot read uploaded file");
}

// POST /api/signing/visual
router.post("/visual", async (req, res) => {
  try {
    const pdfFile = req.files?.pdf;
    if (!pdfFile)
      return res.status(400).json({ error: "PDF file is required." });

    const pdfBuffer = getFileBuffer(pdfFile);
    const body = req.body;

    const placement = body.placement ? JSON.parse(body.placement) : null;
    if (!placement)
      return res
        .status(400)
        .json({ error: "Signature placement is required." });

    const result = await embedVisualSignature(pdfBuffer, {
      signatureImageBase64: body.signatureImage || null,
      page: parseInt(placement.page ?? 0),
      x: parseFloat(placement.x),
      y: parseFloat(placement.y),
      width: parseFloat(placement.width),
      height: parseFloat(placement.height),
      signerName: body.signerName || "",
      date: body.date || new Date().toLocaleString(),
      reason: body.reason || "",
      showDateText: body.showDate !== "false",
      showNameText: body.showName === "true",
    });

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="signed_${pdfFile.name}"`,
      "Content-Length": result.length,
    });
    res.send(result);
  } catch (err) {
    console.error("[signing/visual] Error:", err.message, err.stack);
    res.status(500).json({ error: err.message || "Visual signing failed." });
  }
});

// POST /api/signing/digital
router.post("/digital", async (req, res) => {
  let password = null;
  try {
    const pdfFile = req.files?.pdf;
    const certFile = req.files?.certificate;

    if (!pdfFile)
      return res.status(400).json({ error: "PDF file is required." });
    if (!certFile)
      return res
        .status(400)
        .json({ error: "Certificate (.p12/.pfx) is required." });

    password = req.body.password || "";
    const body = req.body;
    const visible = body.visible !== "false" && body.visible !== false;
    const placement = body.placement ? JSON.parse(body.placement) : null;

    if (visible && !placement) {
      return res
        .status(400)
        .json({ error: "Placement required for visible signature." });
    }

    const pdfBuffer = getFileBuffer(pdfFile);
    const certBuffer = getFileBuffer(certFile);

    const result = await signPdfDigitally(pdfBuffer, {
      p12Buffer: certBuffer,
      password,
      visible,
      placement: placement
        ? {
            x: parseFloat(placement.x),
            y: parseFloat(placement.y),
            width: parseFloat(placement.width),
            height: parseFloat(placement.height),
            page: parseInt(placement.page ?? 0),
          }
        : null,
      signerName: body.signerName || "",
      reason: body.reason || "Approved",
      location: body.location || "",
      contactInfo: body.contactInfo || "",
      signatureImageBase64: body.signatureImage || null,
    });

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="digitally_signed_${pdfFile.name}"`,
      "Content-Length": result.signedPdf.length,
      "X-Signer-Name": result.signerName,
      "X-Signed-At": result.signedAt,
    });
    res.send(result.signedPdf);
  } catch (err) {
    console.error("[signing/digital] Error:", err.message);

    if (err.message.includes("INVALID_PASSWORD")) {
      return res
        .status(422)
        .json({
          error: "Invalid certificate password.",
          code: "INVALID_PASSWORD",
        });
    }
    res.status(500).json({ error: err.message || "Digital signing failed." });
  } finally {
    password = null;
  }
});

// POST /api/signing/verify
router.post("/verify", async (req, res) => {
  try {
    const pdfFile = req.files?.pdf;
    if (!pdfFile)
      return res.status(400).json({ error: "PDF file is required." });

    const report = await verifyPdfSignatures(getFileBuffer(pdfFile));
    res.json(report);
  } catch (err) {
    console.error("[signing/verify] Error:", err.message);
    res.status(500).json({ error: err.message || "Verification failed." });
  }
});

// POST /api/signing/cert-info
router.post("/cert-info", (req, res) => {
  let password = null;
  try {
    const certFile = req.files?.certificate;
    if (!certFile)
      return res.status(400).json({ error: "Certificate file is required." });

    password = req.body.password || "";
    const result = parseCertificate(getFileBuffer(certFile), password);

    if (!result.success) {
      return res
        .status(422)
        .json({ error: result.message, code: result.error });
    }

    const validity = validateCertificateValidity(result.certInfo);

    res.json({
      success: true,
      certInfo: result.certInfo,
      validity,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    password = null;
  }
});

module.exports = router;
