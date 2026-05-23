/**
 * Office Conversion Service
 *
 * Converts between Office formats and PDF using Node.js-native libraries.
 * LibreOffice is used when available for best fidelity; pure-JS fallbacks
 * handle the case where LibreOffice (or Python) is not installed.
 *
 * To → PDF:
 *   wordToPDF   – mammoth (DOCX→HTML→PDF) or LibreOffice
 *   excelToPDF  – xlsx (SheetJS) + pdfkit or LibreOffice
 *   pptToPDF    – PPTX ZIP/XML + pdfkit or LibreOffice
 *
 * From → PDF:
 *   pdfToWord   – pdf-parse text + hand-built DOCX (adm-zip)
 *   pdfToExcel  – pdf-parse text + xlsx (SheetJS)
 *   pdfToPPT    – pdf-parse text + pptxgenjs
 */

const { execFile } = require("child_process");
const util = require("util");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");

const execFileAsync = util.promisify(execFile);

class OfficeConversionService {
  constructor() {
    this._libreOfficePath = this._detectLibreOffice();
    this._loAvailable = null; // cached tri-state: null=unknown, true/false
  }

  // ── LibreOffice detection ─────────────────────────────────────────────────

  _detectLibreOffice() {
    const candidates = [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      "/usr/bin/libreoffice",
      "/usr/bin/soffice",
      "/usr/local/bin/libreoffice",
      "/usr/local/bin/soffice",
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ];
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
        timeout: 5000,
      });
      this._loAvailable = true;
    } catch {
      this._loAvailable = false;
    }
    return this._loAvailable;
  }

  async _libreOfficeToPDF(inputPath) {
    const outputDir = path.dirname(inputPath);
    const outputName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(outputDir, `${outputName}.pdf`);

    await execFileAsync(
      this._libreOfficePath,
      [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        inputPath,
      ],
      { timeout: 60000 },
    );

    const pdfBuffer = await fs.readFile(outputPath);
    await fs.unlink(outputPath).catch(() => {});

    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("LibreOffice produced an empty PDF");
    }
    console.log(
      `[office] LibreOffice converted → ${outputPath} (${pdfBuffer.length} bytes)`,
    );
    return pdfBuffer;
  }

  // ── Word → PDF ────────────────────────────────────────────────────────────

  async wordToPDF(wordFile) {
    const inputPath = wordFile.tempFilePath;
    console.log(`[office] wordToPDF: ${wordFile.name || path.basename(inputPath)}`);

    if (await this._isLibreOfficeAvailable()) {
      return this._libreOfficeToPDF(inputPath);
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
      return this._libreOfficeToPDF(inputPath);
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

    if (await this._isLibreOfficeAvailable()) {
      return this._libreOfficeToPDF(inputPath);
    }

    // Fallback: PPTX is a ZIP containing XML — extract text, render via pdfkit
    try {
      const AdmZip = require("adm-zip");
      const PDFKit = require("pdfkit");

      const zip = new AdmZip(inputPath);
      const entries = zip.getEntries();

      // Collect slides
      const slides = [];
      for (const entry of entries) {
        const m = entry.entryName.match(
          /^ppt\/slides\/slide(\d+)\.xml$/,
        );
        if (!m) continue;

        const xml = entry.getData().toString("utf-8");
        // Extract visible text runs (<a:t>…</a:t>)
        const textMatches = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [];
        const texts = textMatches
          .map((t) => t.replace(/<[^>]+>/g, "").trim())
          .filter(Boolean);

        slides.push({ num: parseInt(m[1], 10), texts });
      }
      slides.sort((a, b) => a.num - b.num);

      const pdf = await new Promise((resolve, reject) => {
        const doc = new PDFKit({
          size: "A4",
          layout: "landscape",
          margins: { top: 50, bottom: 50, left: 55, right: 55 },
        });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        if (slides.length === 0) {
          doc.text("No text content found in this presentation.");
        } else {
          let first = true;
          for (const slide of slides) {
            if (!first) doc.addPage();
            first = false;

            // Slide number (top-right)
            doc
              .fontSize(9)
              .font("Helvetica")
              .fillColor("#999999")
              .text(
                `${slide.num} / ${slides.length}`,
                { align: "right" },
              );
            doc.fillColor("#000000");

            if (slide.texts.length === 0) {
              doc
                .fontSize(12)
                .font("Helvetica")
                .text("(No text content)", { width: 730 });
              continue;
            }

            const [title, ...body] = slide.texts;

            // Title — first text chunk on the slide
            doc
              .fontSize(20)
              .font("Helvetica-Bold")
              .text(title, { width: 730 });
            doc.moveDown(0.5);

            // Body content
            if (body.length > 0) {
              doc
                .fontSize(12)
                .font("Helvetica")
                .text(body.join("\n"), { width: 730 });
            }
          }
        }

        doc.end();
      });

      console.log(`[office] pptToPDF (zip+xml): ${pdf.length} bytes`);
      return pdf;
    } catch (err) {
      throw new Error(`PowerPoint to PDF failed: ${err.message}`);
    }
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
