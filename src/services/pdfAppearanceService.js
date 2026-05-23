/**
 * PDF Appearance Service
 * Handles all visual rendering of signatures onto PDF pages.
 * Used for both standalone visual signing AND as the appearance layer
 * for cryptographic digital signatures.
 *
 * Dependencies: pdf-lib
 */

const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");

/**
 * Embed a visual signature appearance onto a PDF page.
 * This handles Phase 1 (visual-only) signing.
 *
 * @param {Buffer} pdfBuffer - Original PDF bytes
 * @param {Object} request
 * @returns {Promise<Buffer>} - Updated PDF with visual signature
 */
async function embedVisualSignature(pdfBuffer, request) {
  const {
    signatureImageBase64,
    page = 0,
    x,
    y,
    width,
    height,
    signerName,
    date,
    reason,
    showDateText = true,
    showNameText = false,
  } = request;

  console.log("[embedVisualSignature] Starting:", {
    page,
    x,
    y,
    width,
    height,
    hasImage: !!signatureImageBase64,
    imageLen: signatureImageBase64 ? signatureImageBase64.length : 0,
    signerName,
    showDateText,
    showNameText,
  });

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  } catch (loadErr) {
    console.error("[embedVisualSignature] PDF load failed:", loadErr.message);
    throw new Error(`Failed to load PDF: ${loadErr.message}`);
  }

  const pages = pdfDoc.getPages();

  if (page < 0 || page >= pages.length) {
    throw new Error(
      `Page ${page} out of range (document has ${pages.length} pages).`,
    );
  }

  const targetPage = pages[page];
  const { width: pageW, height: pageH } = targetPage.getSize();

  // Proportional size cap: signature should not exceed 30% of page width
  // or 15% of page height, whichever is more constraining.
  const maxW = pageW * 0.30;
  const maxH = pageH * 0.15;
  let finalW = width;
  let finalH = height;

  if (finalW > maxW || finalH > maxH) {
    const scaleW = maxW / finalW;
    const scaleH = maxH / finalH;
    const scale = Math.min(scaleW, scaleH);
    finalW = Math.round(finalW * scale);
    finalH = Math.round(finalH * scale);
    console.log(`[embedVisualSignature] Scaled signature from ${width}x${height} to ${finalW}x${finalH} (page: ${pageW}x${pageH})`);
  }

  // Clamp coordinates to page bounds
  const safeX = Math.max(0, Math.min(x, pageW - finalW));
  const safeY = Math.max(0, Math.min(y, pageH - finalH));

  // Embed signature image
  if (signatureImageBase64) {
    try {
      const imageBytes = base64ToBytes(signatureImageBase64);
      console.log("[embedVisualSignature] Image bytes:", imageBytes.length, "first bytes:", imageBytes[0], imageBytes[1]);

      const isJpeg = detectJpeg(imageBytes);
      const isPng = imageBytes[0] === 0x89 && imageBytes[1] === 0x50; // PNG magic

      let embeddedImage;
      if (isJpeg) {
        embeddedImage = await pdfDoc.embedJpg(imageBytes);
      } else if (isPng) {
        embeddedImage = await pdfDoc.embedPng(imageBytes);
      } else {
        // Try PNG first (most common from canvas), fall back to JPEG
        try {
          embeddedImage = await pdfDoc.embedPng(imageBytes);
        } catch {
          embeddedImage = await pdfDoc.embedJpg(imageBytes);
        }
      }

      targetPage.drawImage(embeddedImage, {
        x: safeX,
        y: safeY,
        width: finalW,
        height: finalH,
      });
      console.log("[embedVisualSignature] Image embedded at", safeX, safeY, `${finalW}x${finalH}`);
    } catch (imgErr) {
      console.error("[embedVisualSignature] Image embed failed:", imgErr.message);
      // Draw a placeholder rectangle + text if image fails
      targetPage.drawRectangle({
        x: safeX,
        y: safeY,
        width: finalW,
        height: finalH,
        borderColor: rgb(0.2, 0.4, 0.8),
        borderWidth: 1,
        color: rgb(0.95, 0.97, 1.0),
      });
      const fallbackFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
      targetPage.drawText(signerName || "Signed", {
        x: safeX + 4,
        y: safeY + finalH / 2 - 5,
        size: Math.min(14, finalH * 0.3),
        font: fallbackFont,
        color: rgb(0.1, 0.1, 0.5),
      });
    }
  } else if (signerName) {
    // No image — draw a styled text signature
    targetPage.drawRectangle({
      x: safeX,
      y: safeY,
      width: finalW,
      height: finalH,
      borderColor: rgb(0.2, 0.4, 0.8),
      borderWidth: 0.5,
      color: rgb(0.97, 0.98, 1.0),
    });
    const sigFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const sigFontSize = Math.min(18, finalH * 0.4);
    targetPage.drawText(signerName, {
      x: safeX + 4,
      y: safeY + finalH * 0.35,
      size: sigFontSize,
      font: sigFont,
      color: rgb(0.05, 0.05, 0.25),
      maxWidth: finalW - 8,
    });
  }

  // Optional text annotations below the signature area
  if (showNameText && signerName) {
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = Math.max(6, finalH * 0.18);
    targetPage.drawText(`Signed by: ${signerName}`, {
      x: safeX + 2,
      y: safeY - fontSize - 2,
      size: fontSize,
      font,
      color: rgb(0.1, 0.1, 0.5),
      maxWidth: finalW - 4,
    });
  }

  if (showDateText && date) {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = Math.max(5, finalH * 0.14);
    const dateStr =
      typeof date === "string" ? date : new Date(date).toLocaleString();
    const nameOffset = showNameText && signerName ? fontSize + 4 : 0;
    targetPage.drawText(dateStr, {
      x: safeX + 2,
      y: safeY - nameOffset - fontSize - 2,
      size: fontSize,
      font,
      color: rgb(0.3, 0.3, 0.3),
      maxWidth: finalW - 4,
    });
  }

  const signedBytes = await pdfDoc.save();
  console.log("[embedVisualSignature] Complete. Output size:", signedBytes.length);
  return Buffer.from(signedBytes);
}

/**
 * Build a professional digital-signature appearance on a PDF page.
 *
 * @param {PDFDocument} pdfDoc - Already-loaded document
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
async function buildDigitalSignatureAppearance(pdfDoc, opts) {
  const {
    signerName = "Signer",
    date = new Date(),
    reason = "",
    location = "",
    signatureImageBase64,
    x,
    y,
    width,
    height,
    pageIndex = 0,
  } = opts;

  const pages = pdfDoc.getPages();
  const targetPage = pages[pageIndex];

  // Background: light blue tinted box with border
  targetPage.drawRectangle({
    x,
    y,
    width,
    height,
    color: rgb(0.94, 0.97, 1.0),
    borderColor: rgb(0.2, 0.4, 0.8),
    borderWidth: 1,
  });

  // Signature image (left side)
  const imgWidth = signatureImageBase64 ? Math.min(width * 0.4, 80) : 0;
  const imgHeight = imgWidth * 0.4;

  if (signatureImageBase64 && imgWidth > 0) {
    const imageBytes = base64ToBytes(signatureImageBase64);
    const isJpeg = detectJpeg(imageBytes);
    const embeddedImage = isJpeg
      ? await pdfDoc.embedJpg(imageBytes)
      : await pdfDoc.embedPng(imageBytes);

    targetPage.drawImage(embeddedImage, {
      x: x + 4,
      y: y + (height - imgHeight) / 2,
      width: imgWidth,
      height: imgHeight,
    });
  }

  // Text block (right side)
  const textX = x + imgWidth + 6;
  const textMaxW = width - imgWidth - 10;
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const baseSize = Math.max(5, Math.min(8, height * 0.18));

  const dateStr =
    date instanceof Date
      ? date.toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : String(date);

  const lines = [
    {
      text: `Digitally signed by: ${signerName}`,
      font: boldFont,
      size: baseSize * 1.1,
    },
    { text: `Date: ${dateStr}`, font: regFont, size: baseSize },
    reason
      ? { text: `Reason: ${reason}`, font: regFont, size: baseSize }
      : null,
    location
      ? { text: `Location: ${location}`, font: regFont, size: baseSize }
      : null,
  ].filter(Boolean);

  let lineY = y + height - baseSize - 4;
  for (const line of lines) {
    if (lineY < y + 2) break;
    targetPage.drawText(line.text, {
      x: textX,
      y: lineY,
      size: line.size,
      font: line.font,
      color: rgb(0.1, 0.1, 0.35),
      maxWidth: textMaxW,
    });
    lineY -= line.size + 2;
  }

  return { pageIndex, x, y, width, height };
}

function base64ToBytes(dataOrBase64) {
  const base64 = dataOrBase64.includes(",")
    ? dataOrBase64.split(",")[1]
    : dataOrBase64;
  return Buffer.from(base64, "base64");
}

function detectJpeg(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

module.exports = { embedVisualSignature, buildDigitalSignatureAppearance };
