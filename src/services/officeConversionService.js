/**
 * Office Conversion Service
 *
 * Converts between Office formats and PDF. LibreOffice is the primary engine
 * (hardened invocation: throwaway profile, hard timeout, serialized via
 * loQueue so only one soffice process runs at a time).
 *
 * To → PDF:
 *   wordToPDF   – LibreOffice, or mammoth (DOCX→HTML→PDF) fallback
 *   excelToPDF  – LibreOffice, or xlsx (SheetJS) + pdfkit fallback
 *   pptToPDF    – LibreOffice ONLY. The old text-extraction fallback is gone:
 *                 it produced unacceptable output while reporting success.
 *                 Without LibreOffice this throws (statusCode 503).
 *
 * From → PDF:
 *   pdfToWord   – pdf-parse text + hand-built DOCX (adm-zip)
 *   pdfToExcel  – pdf-parse text + xlsx (SheetJS)
 *   pdfToPPT    – pdf-parse text + pptxgenjs
 */

const { execFile } = require("child_process");
const util = require("util");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");

const { withLibreOfficeLock } = require("../utils/loQueue");

const execFileAsync = util.promisify(execFile);

const LO_TIMEOUT_MS = 120_000; // hard ceiling per conversion

function engineUnavailableError(message) {
  const err = new Error(message);
  err.code = "ENGINE_UNAVAILABLE";
  err.statusCode = 503;
  return err;
}

function toFileUrl(absPath) {
  const normalized = absPath.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(normalized)
    ? `file:///${normalized}`
    : `file://${normalized}`;
}

class OfficeConversionService {
  constructor() {
    this._libreOfficePath = this._detectLibreOffice();
    this._loAvailable = null; // cached tri-state: null=unknown, true/false
  }

  // ── LibreOffice detection ─────────────────────────────────────────────────

  _detectLibreOffice() {
    const candidates = [
      process.env.LIBREOFFICE_PATH,
      "/usr/bin/soffice",
      "/usr/bin/libreoffice",
      "/usr/local/bin/soffice",
      "/usr/local/bin/libreoffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ].filter(Boolean);
    for (const p of candidates) {
      if (fsSync.existsSync(p)) return p;
    }
    return null;
  }

  async _isLibreOfficeAvailable() {
    if (this._loAvailable !== null) return this._loAvailable;
    if (!this._libreOfficePath) {
      this._loAvailable = false;
      return false;
    }
    try {
      await execFileAsync(this._libreOfficePath, ["--version"], {
        timeout: 15000,
        windowsHide: true,
      });
      this._loAvailable = true;
    } catch {
      this._loAvailable = false;
    }
    return this._loAvailable;
  }

  /**
   * Hardened soffice invocation: unique UserInstallation profile (avoids
   * profile-lock failures), full headless flag set, 120 s timeout with
   * SIGKILL, serialized through the process-wide LibreOffice queue, and
   * temp dirs cleaned up afterwards.
   */
  async _libreOfficeToPDF(inputPath, originalName) {
    return withLibreOfficeLock(async () => {
      const jobId = crypto.randomUUID();
      const profileDir = path.join(os.tmpdir(), `lo-profile-${jobId}`);
      const workDir = path.join(os.tmpdir(), `lo-work-${jobId}`);
      await fs.mkdir(profileDir, { recursive: true });
      await fs.mkdir(workDir, { recursive: true });

      try {
        // Keep the original extension so LibreOffice picks the right import
        // filter (temp upload files have no meaningful extension).
        const ext = path.extname(originalName || inputPath) || "";
        const namedInput = path.join(workDir, `input${ext}`);
        await fs.copyFile(inputPath, namedInput);

        await execFileAsync(
          this._libreOfficePath,
          [
            `-env:UserInstallation=${toFileUrl(profileDir)}`,
            "--headless",
            "--invisible",
            "--nodefault",
            "--norestore",
            "--nolockcheck",
            "--nologo",
            "--nofirststartwizard",
            "--convert-to",
            "pdf",
            "--outdir",
            workDir,
            namedInput,
          ],
          {
            timeout: LO_TIMEOUT_MS,
            killSignal: "SIGKILL",
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
          },
        );

        const outputPath = path.join(workDir, "input.pdf");
        const pdfBuffer = await fs.readFile(outputPath).catch(() => null);
        if (!pdfBuffer || pdfBuffer.length === 0) {
          throw new Error("LibreOffice produced no/empty PDF");
        }
        console.log(
          `[office] LibreOffice converted ${originalName || path.basename(inputPath)} (${pdfBuffer.length} bytes)`,
        );
        return pdfBuffer;
      } finally {
        fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
        fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // ── Word → PDF ────────────────────────────────────────────────────────────

  async wordToPDF(wordFile) {
    const inputPath = wordFile.tempFilePath;
    console.log(`[office] wordToPDF: ${wordFile.name || path.basename(inputPath)}`);

    if (await this._isLibreOfficeAvailable()) {
      return this._libreOfficeToPDF(inputPath, wordFile.name);
    }

    // Fallback: mammoth converts DOCX → HTML; then htmlToPDF renders it
    try {
      const mammoth = require("mammoth");
      const result = await mammoth.convertToHtml({ path: inputPath });

      if (!result || !result.value) {
        throw new Error("mammoth returned empty content");
      }

      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,Helvetica,sans-serif;line-height:1.6;padding:40px;
       max-width:750px;margin:0 auto;color:#222;font-size:12pt}
  h1,h2,h3,h4,h5,h6{color:#111;margin-top:1.4em;margin-bottom:0.4em}
  p{margin:0 0 1em}
  table{border-collapse:collapse;width:100%;margin-bottom:1em}
  td,th{border:1px solid #bbb;padding:6px 10px;text-align:left}
  th{background:#f0f0f0;font-weight:bold}
  ul,ol{margin:0 0 1em;padding-left:2em}
  li{margin-bottom:0.25em}
  blockquote{border-left:3px solid #ccc;margin:0 0 1em 0;padding-left:1em;color:#555}
</style></head>
<body>${result.value}</body></html>`;

      const convertService = require("./convertService");
      const pdf = await convertService.htmlToPDF(html);
      console.log(`[office] wordToPDF (mammoth): ${pdf.length} bytes`);
      return pdf;
    } catch (err) {
      throw new Error(
        `Word to PDF failed: ${err.message}. ` +
          "Install LibreOffice for best results.",
      );
    }
  }

  // ── Excel → PDF ───────────────────────────────────────────────────────────

  async excelToPDF(excelFile) {
    const inputPath = excelFile.tempFilePath;
    console.log(`[office] excelToPDF: ${excelFile.name || path.basename(inputPath)}`);

    if (await this._isLibreOfficeAvailable()) {
      return this._libreOfficeToPDF(inputPath, excelFile.name);
    }

    try {
      const XLSX = require("xlsx");
      const PDFKit = require("pdfkit");

      const workbook = XLSX.readFile(inputPath);

      const pdf = await new Promise((resolve, reject) => {
        const doc = new PDFKit({
          size: "A4",
          layout: "landscape",
          margins: { top: 40, bottom: 40, left: 40, right: 40 },
        });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        let firstSheet = true;
        for (const sheetName of workbook.SheetNames) {
          if (!firstSheet) doc.addPage();
          firstSheet = false;

          doc
            .fontSize(13)
            .font("Helvetica-Bold")
            .fillColor("#333333")
            .text(sheetName, { align: "center" });
          doc.moveDown(0.4);
          doc.font("Helvetica").fontSize(8).fillColor("#000000");

          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
          });

          for (const row of rows) {
            if (!Array.isArray(row) || row.length === 0) continue;
            const line = row
              .map((c) => String(c ?? "").substring(0, 28))
              .join("  │  ");
            if (line.trim()) doc.text(line, { width: 760 });
          }
        }

        doc.end();
      });

      console.log(`[office] excelToPDF (xlsx): ${pdf.length} bytes`);
      return pdf;
    } catch (err) {
      throw new Error(`Excel to PDF failed: ${err.message}`);
    }
  }

  // ── PowerPoint → PDF ─────────────────────────────────────────────────────

  async pptToPDF(pptFile) {
    const inputPath = pptFile.tempFilePath;
    console.log(`[office] pptToPDF: ${pptFile.name || path.basename(inputPath)}`);

    // LibreOffice only — no fallback. The old AdmZip+PDFKit text extractor
    // silently returned slides stripped of all shapes/colors/tables/charts,
    // which is worse than an honest failure.
    if (!(await this._isLibreOfficeAvailable())) {
      throw engineUnavailableError(
        "PowerPoint conversion requires LibreOffice, which is not available on this server. " +
          "No degraded fallback is provided.",
      );
    }
    return this._libreOfficeToPDF(inputPath, pptFile.name);
  }

  // ── PDF → Word ────────────────────────────────────────────────────────────

  async pdfToWord(pdfFile) {
    const inputPath = pdfFile.tempFilePath;
    console.log(`[office] pdfToWord: ${pdfFile.name || path.basename(inputPath)}`);

    // Extract text from PDF
    const { parsePDF } = require("../utils/pdfParser");
    const pdfBytes = await fs.readFile(inputPath);
    const data = await parsePDF(pdfBytes);
    const text = (data.text || "").trim();

    // Build a minimal but spec-compliant DOCX (ZIP of XML files)
    const AdmZip = require("adm-zip");

    const xmlEscape = (s) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    // Convert text into <w:p> elements
    const paragraphs = text
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const paraXml = paragraphs
      .map((p) => {
        const lineNodes = p.split(/\n/).reduce((acc, line, i, arr) => {
          acc += `<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`;
          if (i < arr.length - 1) acc += "<w:r><w:br/></w:r>";
          return acc;
        }, "");
        return `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr>${lineNodes}</w:p>`;
      })
      .join("\n    ");

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`;

    const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    Target="styles.xml"/>
</Relationships>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  mc:Ignorable="w14">
  <w:body>
    ${paraXml || "<w:p><w:r><w:t>No text content found in PDF.</w:t></w:r></w:p>"}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"
               w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  mc:Ignorable="">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Times New Roman"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
        <w:lang w:val="en-US"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="160" w:line="259" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from(contentTypes, "utf-8"));
    zip.addFile("_rels/.rels", Buffer.from(rels, "utf-8"));
    zip.addFile(
      "word/_rels/document.xml.rels",
      Buffer.from(wordRels, "utf-8"),
    );
    zip.addFile("word/document.xml", Buffer.from(documentXml, "utf-8"));
    zip.addFile("word/styles.xml", Buffer.from(stylesXml, "utf-8"));

    const docxBuffer = zip.toBuffer();
    console.log(`[office] pdfToWord: ${docxBuffer.length} bytes`);
    return docxBuffer;
  }

  // ── PDF → Excel ───────────────────────────────────────────────────────────

  async pdfToExcel(pdfFile) {
    const inputPath = pdfFile.tempFilePath;
    console.log(`[office] pdfToExcel: ${pdfFile.name || path.basename(inputPath)}`);

    const { parsePDF } = require("../utils/pdfParser");
    const pdfBytes = await fs.readFile(inputPath);
    const data = await parsePDF(pdfBytes);
    const text = data.text || "";

    const XLSX = require("xlsx");

    // Heuristic: lines with 2+ consecutive spaces or tabs are table rows
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const rows = lines.map((line) => {
      const cols = line
        .split(/\s{2,}|\t/)
        .map((c) => c.trim())
        .filter(Boolean);
      return cols.length > 1 ? cols : [line.trim()];
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, "PDF Content");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const result = Buffer.from(buffer);
    console.log(`[office] pdfToExcel: ${result.length} bytes`);
    return result;
  }

  // ── PDF → PowerPoint ──────────────────────────────────────────────────────

  async pdfToPPT(pdfFile) {
    const inputPath = pdfFile.tempFilePath;
    console.log(`[office] pdfToPPT: ${pdfFile.name || path.basename(inputPath)}`);

    const { parsePDF } = require("../utils/pdfParser");
    const pdfBytes = await fs.readFile(inputPath);
    const data = await parsePDF(pdfBytes);
    const text = data.text || "";

    const pptxgen = require("pptxgenjs");
    const prs = new pptxgen();

    // One slide per "page" — split on form feeds or 4+ blank lines
    const pages = text
      .split(/\f|\n{4,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const total = Math.max(pages.length, 1);

    for (let i = 0; i < total; i++) {
      const slide = prs.addSlide();
      const pageText = pages[i] || "";

      // Page counter (bottom-right)
      slide.addText(`${i + 1} / ${total}`, {
        x: 8.5,
        y: 7.1,
        w: 1.4,
        h: 0.3,
        fontSize: 9,
        color: "AAAAAA",
        align: "right",
      });

      if (!pageText) {
        slide.addText("(empty page)", {
          x: 0.5,
          y: 3.0,
          w: 9,
          h: 1.0,
          fontSize: 14,
          color: "AAAAAA",
          align: "center",
        });
        continue;
      }

      const lines = pageText.split("\n");
      const firstLine = lines[0].trim();
      const bodyText = lines.slice(1).join("\n").trim();

      if (firstLine.length < 80) {
        // Treat first line as slide title
        slide.addText(firstLine, {
          x: 0.5,
          y: 0.35,
          w: 9,
          h: 0.9,
          fontSize: 20,
          bold: true,
          color: "222222",
          wrap: true,
        });
        if (bodyText) {
          slide.addText(bodyText.substring(0, 2500), {
            x: 0.5,
            y: 1.4,
            w: 9,
            h: 5.8,
            fontSize: 11,
            color: "333333",
            wrap: true,
            valign: "top",
          });
        }
      } else {
        // Everything as body content
        slide.addText(pageText.substring(0, 2500), {
          x: 0.5,
          y: 0.5,
          w: 9,
          h: 6.7,
          fontSize: 11,
          color: "333333",
          wrap: true,
          valign: "top",
        });
      }
    }

    const buffer = await prs.write({ outputType: "nodebuffer" });
    const result = Buffer.from(buffer);
    console.log(`[office] pdfToPPT: ${result.length} bytes`);
    return result;
  }

  // ── Public helper ─────────────────────────────────────────────────────────

  async isLibreOfficeAvailable() {
    return this._isLibreOfficeAvailable();
  }
}

module.exports = new OfficeConversionService();
