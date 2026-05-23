/**
 * PDF Digital Signing Service
 * Implements real, Adobe-compatible cryptographic PDF digital signatures.
 *
 * Pipeline:
 *   1. Load PDF with pdf-lib
 *   2. Add AcroForm signature field + widget annotation
 *   3. Add visual appearance if requested
 *   4. Add ByteRange + Contents placeholder
 *   5. Serialize PDF
 *   6. Compute actual ByteRange over the serialized bytes
 *   7. Build PKCS#7 CMS signature over the covered bytes
 *   8. Splice signature into reserved Contents slot
 *   9. Return final signed PDF buffer
 *
 * Dependencies: pdf-lib, node-forge, @signpdf/placeholder-pdf-lib, @signpdf/signer-p12, @signpdf/signpdf
 */

const { PDFDocument, PDFName } = require("pdf-lib");
const { pdflibAddPlaceholder } = require("@signpdf/placeholder-pdf-lib");
const { P12Signer } = require("@signpdf/signer-p12");
const signpdf = require("@signpdf/signpdf").default;
const { buildDigitalSignatureAppearance } = require("./pdfAppearanceService");

/**
 * Sign a PDF cryptographically.
 *
 * @param {Buffer} pdfBuffer
 * @param {Object} request
 * @returns {Promise<Object>}
 */
async function signPdfDigitally(pdfBuffer, request) {
  const {
    p12Buffer,
    password,
    visible = true,
    placement,
    signerName = "",
    reason = "I approve this document",
    location = "",
    contactInfo = "",
    signatureImageBase64,
  } = request;

  if (!p12Buffer || !password) {
    throw new Error("Certificate buffer and password are required.");
  }

  // Step 1: Load PDF
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch (err) {
    throw new Error(`Failed to load PDF: ${err.message}`);
  }

  const pages = pdfDoc.getPages();
  const pageIndex = placement?.page ?? 0;

  if (pageIndex >= pages.length) {
    throw new Error(`Page index ${pageIndex} out of range.`);
  }

  // Step 2: Ensure AcroForm exists
  if (!pdfDoc.catalog.has(PDFName.of("AcroForm"))) {
    pdfDoc.catalog.set(
      PDFName.of("AcroForm"),
      pdfDoc.context.obj({
        Fields: [],
      }),
    );
  }

  // Step 3: Add visual appearance (if visible signing)
  if (visible && placement) {
    await buildDigitalSignatureAppearance(pdfDoc, {
      signerName,
      date: new Date(),
      reason,
      location,
      signatureImageBase64,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      pageIndex: pageIndex,
    });
  }

  // Step 4: Add placeholder via @signpdf/placeholder-pdf-lib
  await pdflibAddPlaceholder({
    pdfDoc,
    reason,
    contactInfo: contactInfo || "",
    name: signerName || "",
    location: location || "",
    signatureLength: 8192,
    ...(visible && placement
      ? {
          widgetRect: [
            placement.x,
            placement.y,
            placement.x + placement.width,
            placement.y + placement.height,
          ],
        }
      : {}),
  });

  // Step 5: Serialize the prepared PDF
  const preparedPdfBytes = await pdfDoc.save({ useObjectStreams: false });
  const preparedBuffer = Buffer.from(preparedPdfBytes);

  // Step 6 + 7: Sign with P12 signer
  let signedBuffer;
  try {
    const signer = new P12Signer(p12Buffer, { passphrase: password });
    const signedBytes = await signpdf.sign(preparedBuffer, signer);
    signedBuffer = Buffer.from(signedBytes);
  } catch (err) {
    if (err.message && err.message.toLowerCase().includes("password")) {
      throw new Error("INVALID_PASSWORD: Certificate password is incorrect.");
    }
    throw new Error(`Signing failed: ${err.message}`);
  }

  return {
    success: true,
    signedPdf: signedBuffer,
    signerName,
    reason,
    location,
    signedAt: new Date().toISOString(),
    fileSize: signedBuffer.length,
    isVisible: visible,
  };
}

module.exports = { signPdfDigitally };
