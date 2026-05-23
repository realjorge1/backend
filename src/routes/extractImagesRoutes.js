const express = require("express");
const router = express.Router();
const { PDFDocument, PDFName, PDFArray } = require("pdf-lib");
const fs = require("fs").promises;
const fsSync = require("fs");
const sharp = require("sharp");
const archiver = require("archiver");
const zlib = require("zlib");
const {
  outputPath,
  toDownloadUrl,
  cleanupFiles,
} = require("../utils/fileOutputUtils");
const { safeLoadPDF } = require("../services/pdfService");

/**
 * POST /api/extract-images
 * Extracts all embedded images from a PDF.
 *
 * Phase 1: pdf-lib context enumeration (fast, handles JPEG/JP2/raw).
 * Phase 2: pdfjs-dist operator list extraction (catches images Phase 1 misses).
 *
 * Returns: { images: [{ name, url, width, height, format, page }], zipUrl, count }
 */
router.post("/", async (req, res, next) => {
  if (!req.files?.pdf) {
    return res.status(400).json({ error: "No PDF uploaded" });
  }

  const inputPath = req.files.pdf.tempFilePath;
  const extractedPaths = [];

  try {
    const pdfBytes = await fs.readFile(inputPath);
    const images = [];
    let imgIndex = 0;

    // ── Phase 1: pdf-lib direct stream extraction ────────────────────
    // Enumerates ALL indirect objects to find image XObjects regardless of
    // nesting depth. Handles JPEG (DCTDecode), JP2 (JPXDecode), and
    // raw/FlateDecode pixel data.
    try {
      const pdfDoc = await safeLoadPDF(pdfBytes, {
        ignoreEncryption: true,
      });

      for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
        // Accept any object with a dict and stream content
        if (!obj || typeof obj !== "object" || !obj.dict) continue;

        // Get raw bytes — PDFRawStream uses .contents, PDFFlateStream may
        // expose .getContents() or .getUnencodedContents()
        let imgBytes = null;
        if (obj.contents instanceof Uint8Array && obj.contents.length > 0) {
          imgBytes = obj.contents;
        } else if (typeof obj.getContents === "function") {
          try {
            imgBytes = obj.getContents();
          } catch { /* skip */ }
        } else if (typeof obj.getUnencodedContents === "function") {
          try {
            imgBytes = obj.getUnencodedContents();
          } catch { /* skip */ }
        }
        if (!imgBytes || imgBytes.length === 0) continue;

        const dict = obj.dict;

        // Must be an Image XObject
        let subtype;
        try {
          subtype = dict.lookup?.(PDFName.of("Subtype")) || dict.get?.(PDFName.of("Subtype"));
        } catch { continue; }
        if (!subtype) continue;
        const subtypeStr = subtype.toString?.() || String(subtype);
        if (subtypeStr !== "/Image") continue;

        let widthObj, heightObj, bitsPerComponent, colorSpace, filter, sMask;
        try {
          const lookup = (name) => dict.lookup?.(PDFName.of(name)) || dict.get?.(PDFName.of(name));
          filter = lookup("Filter");
          widthObj = lookup("Width");
          heightObj = lookup("Height");
          bitsPerComponent = lookup("BitsPerComponent");
          colorSpace = lookup("ColorSpace");
          sMask = lookup("SMask");
        } catch { continue; }

        const imgWidth = widthObj?.asNumber?.() || widthObj?.numberValue?.() || parseNumVal(widthObj) || 0;
        const imgHeight = heightObj?.asNumber?.() || heightObj?.numberValue?.() || parseNumVal(heightObj) || 0;
        if (imgWidth === 0 || imgHeight === 0) continue;

        // Determine encoding
        const filterName = resolveFilterName(filter);

        // Skip CCITTFaxDecode / JBIG2Decode in phase 1 — hard to decode without
        // a full PDF renderer. Phase 2 will catch them.
        if (filterName.includes("CCITTFaxDecode") || filterName.includes("JBIG2Decode")) continue;

        let ext = ".png";
        let format = "png";

        if (filterName.includes("DCTDecode")) {
          ext = ".jpg";
          format = "jpeg";
        } else if (filterName.includes("JPXDecode")) {
          ext = ".jp2";
          format = "jp2";
        }

        const imgName = `image_${String(imgIndex + 1).padStart(3, "0")}${ext}`;
        const imgOutPath = outputPath(ext);

        try {
          if (format === "jpeg") {
            // DCTDecode: the stream bytes ARE valid JPEG data.
            // If also wrapped in FlateDecode, decompress first.
            let jpegData = Buffer.from(imgBytes);
            if (filterName.includes("FlateDecode") && filterName.indexOf("FlateDecode") < filterName.indexOf("DCTDecode")) {
              try { jpegData = zlib.inflateSync(jpegData); } catch { /* already decompressed */ }
            }
            await fs.writeFile(imgOutPath, jpegData);
          } else if (format === "jp2") {
            // JPXDecode: write raw bytes directly — viewers handle JP2
            let jp2Data = Buffer.from(imgBytes);
            if (filterName.includes("FlateDecode")) {
              try { jp2Data = zlib.inflateSync(jp2Data); } catch { /* ok */ }
            }
            await fs.writeFile(imgOutPath, jp2Data);
          } else {
            // FlateDecode or raw: decompress and reconstruct as PNG via sharp
            const bpc = bitsPerComponent?.asNumber?.() || parseNumVal(bitsPerComponent) || 8;
            const csName = resolveColorSpaceName(colorSpace);
            let channels = csName === "DeviceGray" ? 1 : csName === "DeviceCMYK" ? 4 : 3;

            // If there's an SMask (soft mask / alpha), account for it
            if (sMask) channels = Math.min(channels + 1, 4);

            let rawPixels = Buffer.from(imgBytes);

            // Attempt zlib decompression (FlateDecode streams are zlib-compressed)
            try {
              rawPixels = zlib.inflateSync(rawPixels);
            } catch {
              // Might already be raw pixels — proceed anyway
            }

            // Handle PNG predictor bytes: each row may have an extra filter byte
            const bytesPerPixel = channels * (bpc / 8);
            const rowBytesNoPred = Math.ceil(imgWidth * bytesPerPixel);
            const rowBytesWithPred = rowBytesNoPred + 1;
            const hasPredictorBytes = rawPixels.length >= imgHeight * rowBytesWithPred &&
              rawPixels.length < imgHeight * (rowBytesNoPred + 2);

            if (hasPredictorBytes && rawPixels.length !== imgHeight * rowBytesNoPred) {
              // Strip the leading predictor byte from each row
              const stripped = Buffer.alloc(imgHeight * rowBytesNoPred);
              for (let row = 0; row < imgHeight; row++) {
                rawPixels.copy(
                  stripped,
                  row * rowBytesNoPred,
                  row * rowBytesWithPred + 1,
                  row * rowBytesWithPred + 1 + rowBytesNoPred,
                );
              }
              rawPixels = stripped;
            }

            const expectedSize = imgWidth * imgHeight * channels * (bpc / 8);
            // Skip if data is far too small (< 10% of expected)
            if (rawPixels.length < expectedSize * 0.1) continue;

            // For CMYK, convert to RGB first
            if (csName === "DeviceCMYK") {
              try {
                const pngBuffer = await sharp(rawPixels, {
                  raw: { width: imgWidth, height: imgHeight, channels: 4 },
                })
                  .toColorspace("srgb")
                  .png()
                  .toBuffer();
                await fs.writeFile(imgOutPath, pngBuffer);
              } catch {
                await cleanupFiles(imgOutPath);
                continue;
              }
            } else {
              try {
                const sharpChannels = Math.min(channels, 4);
                const pngBuffer = await sharp(rawPixels, {
                  raw: { width: imgWidth, height: imgHeight, channels: sharpChannels },
                })
                  .png()
                  .toBuffer();
                await fs.writeFile(imgOutPath, pngBuffer);
              } catch {
                // Try alternative: feed to sharp without raw options (it may auto-detect)
                try {
                  const pngBuffer = await sharp(rawPixels).png().toBuffer();
                  await fs.writeFile(imgOutPath, pngBuffer);
                } catch {
                  await cleanupFiles(imgOutPath);
                  continue;
                }
              }
            }
          }

          // Verify output has content
          const stat = await fs.stat(imgOutPath);
          if (stat.size === 0) {
            await cleanupFiles(imgOutPath);
            continue;
          }

          extractedPaths.push(imgOutPath);
          images.push({
            name: imgName,
            url: toDownloadUrl(req, imgOutPath),
            width: imgWidth,
            height: imgHeight,
            format,
          });
          imgIndex++;
        } catch {
          await cleanupFiles(imgOutPath);
        }
      }
    } catch (phase1Err) {
      console.warn("[extract-images] Phase 1 (pdf-lib) error:", phase1Err.message);
    }

    // ── Phase 2: pdfjs-dist operator list extraction ─────────────────
    // Catches images that Phase 1 missed (CCITTFaxDecode, JBIG2, inline
    // images, complex filter chains, etc.) by leveraging pdfjs-dist's
    // full PDF renderer to decode image data.
    if (images.length === 0) {
      try {
        const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
        // Disable worker to prevent version mismatch in Node.js
        if (pdfjsLib.GlobalWorkerOptions) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = "";
        }
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(pdfBytes),
          useSystemFonts: true,
        });
        const pdfDoc2 = await loadingTask.promise;
        const numPages = pdfDoc2.numPages;

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
          const page = await pdfDoc2.getPage(pageNum);
          const ops = await page.getOperatorList();

          for (let i = 0; i < ops.fnArray.length; i++) {
            // OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82
            const fn = ops.fnArray[i];
            if (fn !== 85 && fn !== 82) continue;

            const imgName2 = ops.argsArray[i]?.[0];
            if (!imgName2) continue;

            try {
              // page.objs.get returns the decoded image data
              const imgData = await new Promise((resolve, reject) => {
                // Try page-level objects first, then common objects
                const tryResolve = (src) => {
                  try {
                    src.get(imgName2, (data) => {
                      if (data) resolve(data);
                      else reject(new Error("no data"));
                    });
                  } catch { reject(new Error("not found")); }
                };

                // pdfjs stores images in page.objs or page.commonObjs
                try {
                  tryResolve(page.objs);
                } catch {
                  try {
                    tryResolve(page.commonObjs);
                  } catch {
                    reject(new Error("image not found in objs"));
                  }
                }

                // Timeout after 5s per image
                setTimeout(() => reject(new Error("timeout")), 5000);
              });

              if (!imgData?.data || !imgData.width || !imgData.height) continue;

              // imgData.data is a Uint8ClampedArray of RGBA pixels
              const w = imgData.width;
              const h = imgData.height;
              const channels = imgData.data.length / (w * h);
              const sharpChannels = Math.min(Math.round(channels), 4) || 4;

              const ext2 = ".png";
              const imgOutPath2 = outputPath(ext2);

              const pngBuffer = await sharp(Buffer.from(imgData.data), {
                raw: { width: w, height: h, channels: sharpChannels },
              })
                .png()
                .toBuffer();

              await fs.writeFile(imgOutPath2, pngBuffer);

              const stat2 = await fs.stat(imgOutPath2);
              if (stat2.size === 0) {
                await cleanupFiles(imgOutPath2);
                continue;
              }

              extractedPaths.push(imgOutPath2);
              images.push({
                name: `image_${String(imgIndex + 1).padStart(3, "0")}.png`,
                url: toDownloadUrl(req, imgOutPath2),
                width: w,
                height: h,
                format: "png",
                page: pageNum,
              });
              imgIndex++;
            } catch {
              // Skip this image
            }
          }

          page.cleanup();
        }

        pdfDoc2.destroy();
      } catch (phase2Err) {
        console.warn("[extract-images] Phase 2 (pdfjs-dist) error:", phase2Err.message);
      }
    }

    if (images.length === 0) {
      return res.status(404).json({
        error: "No extractable images found in this PDF",
        count: 0,
        images: [],
      });
    }

    // Create ZIP if multiple images
    let zipUrl = null;
    if (images.length > 1) {
      const zipOutPath = outputPath(".zip");
      await new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(zipOutPath);
        const archive = archiver("zip", { zlib: { level: 6 } });
        output.on("close", resolve);
        archive.on("error", reject);
        archive.pipe(output);
        extractedPaths.forEach((fp, i) =>
          archive.file(fp, { name: images[i].name }),
        );
        archive.finalize();
      });
      zipUrl = toDownloadUrl(req, zipOutPath);
    }

    return res.json({ count: images.length, images, zipUrl });
  } catch (err) {
    next(err);
  }
});

/**
 * Parse a numeric value from a PDF object.
 */
function parseNumVal(obj) {
  if (!obj) return 0;
  if (typeof obj === "number") return obj;
  if (typeof obj.value === "number") return obj.value;
  const str = obj.toString?.() || "";
  const n = parseInt(str, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Resolve the filter name from a PDF filter object (handles arrays).
 */
function resolveFilterName(filter) {
  if (!filter) return "";
  const str = filter.toString?.() || String(filter);
  if (str.startsWith("[")) {
    if (filter instanceof PDFArray) {
      const names = [];
      for (let i = 0; i < filter.size(); i++) {
        names.push(filter.get(i).toString());
      }
      return names.join(",");
    }
    // Parse array-like string: "[ /FlateDecode /DCTDecode ]"
    return str;
  }
  return str;
}

/**
 * Resolve color space name from a PDF color space object.
 */
function resolveColorSpaceName(colorSpace) {
  if (!colorSpace) return "DeviceRGB";
  const str = colorSpace.toString?.() || String(colorSpace);
  if (str.includes("Gray")) return "DeviceGray";
  if (str.includes("CMYK")) return "DeviceCMYK";
  if (str.includes("RGB")) return "DeviceRGB";
  if (str.includes("Indexed") || str.includes("CalRGB")) return "DeviceRGB";
  if (str.includes("CalGray")) return "DeviceGray";
  if (str.includes("ICCBased")) return "DeviceRGB"; // Most ICC profiles are sRGB
  return "DeviceRGB";
}

module.exports = router;
