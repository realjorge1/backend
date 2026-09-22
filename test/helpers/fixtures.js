/**
 * Document fixtures built in-process, so no binary files live in the repo.
 */

const AdmZip = require("adm-zip");

const CT_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A real PDF with one line of text per page. */
async function makePdf(lines = ["Revenue grew by 15 percent."]) {
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of lines) {
    const page = doc.addPage([612, 792]);
    page.drawText(line, { x: 50, y: 700, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

function zipOf(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}

/**
 * DOCX with optional Heading 1/2 paragraphs.
 * @param {Array<{text: string, heading?: 1|2|3}>} paragraphs
 */
function makeDocx(paragraphs) {
  const body = paragraphs
    .map((p) => {
      const style = p.heading ? `<w:pPr><w:pStyle w:val="Heading${p.heading}"/></w:pPr>` : "";
      return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(p.text)}</w:t></w:r></w:p>`;
    })
    .join("");

  const styles = [1, 2, 3]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`,
    )
    .join("");

  return zipOf({
    "[Content_Types].xml": `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": `${CT_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`,
    "word/document.xml": `${CT_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/**
 * PPTX whose slide *file* order differs from its presentation order, so the
 * old localeCompare sort (1, 10, 11, 2, ...) is distinguishable from the real
 * sldIdLst order.
 *
 * @param {string[]} slideTexts  text for slide 1..N in presentation order
 * @param {object} opts  { notes: {slideIndex: text}, order: number[] }
 */
function makePptx(slideTexts, opts = {}) {
  const entries = {};
  const n = slideTexts.length;
  // Presentation order: by default 1..N mapped to slide file 1..N.
  const order = opts.order || slideTexts.map((_, i) => i + 1);

  const sldIds = order
    .map((fileNum, idx) => `<p:sldId id="${256 + idx}" r:id="rId${fileNum}"/>`)
    .join("");

  entries["ppt/presentation.xml"] =
    `${CT_HEADER}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`;

  const rels = order
    .map(
      (fileNum) =>
        `<Relationship Id="rId${fileNum}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${fileNum}.xml"/>`,
    )
    .join("");
  entries["ppt/_rels/presentation.xml.rels"] =
    `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;

  order.forEach((fileNum, idx) => {
    const text = slideTexts[idx];
    const paragraphs = String(text)
      .split("\n")
      .map((line) => `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`)
      .join("");
    entries[`ppt/slides/slide${fileNum}.xml`] =
      `${CT_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

    const note = opts.notes && opts.notes[idx];
    if (note) {
      entries[`ppt/slides/_rels/slide${fileNum}.xml.rels`] =
        `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${fileNum}.xml"/></Relationships>`;
      entries[`ppt/notesSlides/notesSlide${fileNum}.xml`] =
        `${CT_HEADER}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${escapeXml(note)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });

  entries["[Content_Types].xml"] =
    `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;

  return zipOf(entries);
}

/**
 * XLSX with shared strings (including a rich-text run), numbers, booleans,
 * inline strings and a formula with a cached value.
 *
 * @param {Array<{name: string, rows: Array<Array<{ref: string, type?: string, value: string, formula?: string}>>}>} sheets
 * @param {string[]} sharedStrings  plain shared strings; index referenced by t="s"
 * @param {Array<string[]>} richStrings  each entry is the runs of one rich-text shared string
 */
function makeXlsx(sheets, sharedStrings = [], richStrings = []) {
  const entries = {};

  const siPlain = sharedStrings
    .map((s) => `<si><t>${escapeXml(s)}</t></si>`)
    .join("");
  const siRich = richStrings
    .map(
      (runs) =>
        `<si>${runs.map((r) => `<r><t>${escapeXml(r)}</t></r>`).join("")}</si>`,
    )
    .join("");
  const totalStrings = sharedStrings.length + richStrings.length;
  entries["xl/sharedStrings.xml"] =
    `${CT_HEADER}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalStrings}" uniqueCount="${totalStrings}">${siPlain}${siRich}</sst>`;

  const sheetTags = sheets
    .map(
      (s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join("");
  entries["xl/workbook.xml"] =
    `${CT_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`;

  const wbRels = sheets
    .map(
      (s, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  entries["xl/_rels/workbook.xml.rels"] =
    `${CT_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}</Relationships>`;

  sheets.forEach((sheet, i) => {
    const rows = sheet.rows
      .map((cells, rowIdx) => {
        const cellXml = cells
          .map((c) => {
            const t = c.type ? ` t="${c.type}"` : "";
            const f = c.formula ? `<f>${escapeXml(c.formula)}</f>` : "";
            const body =
              c.type === "inlineStr"
                ? `<is><t>${escapeXml(c.value)}</t></is>`
                : `<v>${escapeXml(c.value)}</v>`;
            return `<c r="${c.ref}"${t}>${f}${body}</c>`;
          })
          .join("");
        const rowNum = cells[0] ? parseInt(cells[0].ref.replace(/[A-Z]/g, ""), 10) : rowIdx + 1;
        return `<row r="${rowNum}">${cellXml}</row>`;
      })
      .join("");
    entries[`xl/worksheets/sheet${i + 1}.xml`] =
      `${CT_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  entries["[Content_Types].xml"] =
    `${CT_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;

  return zipOf(entries);
}

/** Minimal EPUB with a spine of chapters. */
function makeEpub(chapters) {
  const entries = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `${CT_HEADER}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  };

  const manifest = chapters
    .map((_, i) => `<item id="c${i + 1}" href="chap${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("");
  entries["OEBPS/content.opf"] =
    `${CT_HEADER}<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;

  chapters.forEach((ch, i) => {
    entries[`OEBPS/chap${i + 1}.xhtml`] =
      `${CT_HEADER}<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>${escapeXml(ch.title)}</h1><p>${escapeXml(ch.text)}</p></body></html>`;
  });

  return zipOf(entries);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { makePdf, makeDocx, makePptx, makeXlsx, makeEpub };
