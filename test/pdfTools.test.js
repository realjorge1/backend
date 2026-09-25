/**
 * PDF tool routes used by the app's Tools tab:
 *  - /pdf/stamp honours the placed box and page list (and keeps the old
 *    top-right-on-every-page behaviour when neither is sent)
 *  - /pdf/watermark accepts a logo, with or without text
 *  - /convert/pdf-to-png|jpg return every page with allPages=true, and still
 *    a single image without it (older app builds)
 *  - /pdf/merge decrypts permission-only PDFs, and names a PDF that needs a
 *    password with a 400 instead of failing with "Cannot read ... 'Pages'"
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const fileUpload = require("express-fileupload");
const fs = require("fs");
const os = require("os");
const path = require("path");
const request = require("supertest");

const {
  normalizeFileFields,
  cleanupTempFiles,
} = require("../src/middleware/uploadMiddleware");
const { OUTPUTS_DIR } = require("../src/utils/fileOutputUtils");
const { encryptPdfBuffer } = require("../src/services/pdfEncryption");
const { makePdf } = require("./helpers/fixtures");

// 1×1 red PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let app;
let threePages;

before(async () => {
  // Same parser chain as src/server.js — without the body parsers a
  // file-only upload leaves req.body undefined, which production never sees.
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    fileUpload({
      useTempFiles: true,
      tempFileDir: path.join(os.tmpdir(), "inscribed-test") + path.sep,
      createParentPath: true,
      parseNested: true,
      abortOnLimit: false,
    }),
  );
  app.use(normalizeFileFields);
  app.use(cleanupTempFiles);
  app.use("/api/pdf", require("../src/routes/pdfRoutes"));
  app.use("/api/convert", require("../src/routes/convertRoutes"));
  threePages = await makePdf(["One", "Two", "Three"]);
});

/** supertest collects binary bodies as a Buffer. */
const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

/** Bounding boxes (top-left origin, points) of `word` on each page. */
async function findText(pdfBuf, word) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdfBuf, "application/pdf");
  const hits = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const json = JSON.parse(doc.loadPage(i).toStructuredText().asJSON());
    for (const block of json.blocks) {
      for (const line of block.lines || []) {
        if (line.text.includes(word)) hits.push({ page: i + 1, bbox: line.bbox });
      }
    }
  }
  return hits;
}

/** Every image drawn, per page: box (top-left origin, points) and opacity. */
async function findImages(pdfBuf) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdfBuf, "application/pdf");
  const hits = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const device = new mupdf.Device({
      fillImage(_image, [w, , , h, x, y], alpha) {
        hits.push({ page: i + 1, x, y, w, h, alpha });
      },
    });
    doc.loadPage(i).run(device, mupdf.Matrix.identity);
    device.close();
  }
  return hits;
}

const near = (a, b) => Math.abs(a - b) < 0.01;

const stamp = (fields) => {
  const req = request(app)
    .post("/api/pdf/stamp")
    .attach("file", threePages, "doc.pdf")
    .buffer(true)
    .parse(binary);
  for (const [k, v] of Object.entries(fields)) req.field(k, v);
  return req;
};

test("stamp without a position keeps the old behaviour: every page, top-right", async () => {
  const res = await stamp({ stampType: "approved", pageNumber: "0" });
  assert.strictEqual(res.status, 200);
  const hits = await findText(res.body, "APPROVED");
  assert.deepStrictEqual(hits.map((h) => h.page), [1, 2, 3]);
  for (const { bbox } of hits) {
    assert.ok(bbox.x > 300, `x=${bbox.x} should be on the right`);
    assert.ok(bbox.y < 120, `y=${bbox.y} should be near the top`);
  }
});

test("stamp lands inside the placed box, only on the requested pages", async () => {
  // Box 50..250 × 100..160 in PDF points (bottom-left origin) → top-left
  // origin on a 792pt page: y from 632 to 692.
  const res = await stamp({
    stampType: "confidential",
    x: "50",
    y: "100",
    width: "200",
    height: "60",
    pages: "[2]",
  });
  assert.strictEqual(res.status, 200);
  const hits = await findText(res.body, "CONFIDENTIAL");
  assert.deepStrictEqual(hits.map((h) => h.page), [2]);
  const { bbox } = hits[0];
  assert.ok(bbox.x >= 50 && bbox.x + bbox.w <= 250, `x ${bbox.x}+${bbox.w}`);
  assert.ok(bbox.y >= 632 && bbox.y + bbox.h <= 692, `y ${bbox.y}+${bbox.h}`);
});

test("stamp rejects a malformed page list", async () => {
  const res = await request(app)
    .post("/api/pdf/stamp")
    .attach("file", threePages, "doc.pdf")
    .field("pages", "1,3");
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, "Invalid pages");
  assert.match(res.body.message, /page numbers/);
});

test("watermark accepts a logo without text", async () => {
  const res = await request(app)
    .post("/api/pdf/watermark")
    .attach("file", threePages, "doc.pdf")
    .attach("logo", PNG, "logo.png")
    .field("logoPosition", "bottom-right")
    .buffer(true)
    .parse(binary);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["content-type"], "application/pdf");
  assert.ok(res.body.toString("latin1").includes("/Subtype /Image"));

  // 612×792 pages: a square logo fits 30% of the width (183.6pt), 36pt in
  // from the bottom-right corner, at the default opacity.
  const images = await findImages(res.body);
  assert.deepStrictEqual(images.map((i) => i.page), [1, 2, 3]);
  for (const img of images) {
    assert.ok(near(img.w, 183.6) && near(img.h, 183.6), `size ${img.w}×${img.h}`);
    assert.ok(near(img.x + img.w, 612 - 36), `right edge ${img.x + img.w}`);
    assert.ok(near(img.y + img.h, 792 - 36), `bottom edge ${img.y + img.h}`);
    assert.ok(near(img.alpha, 0.3), `opacity ${img.alpha}`);
  }
});

test("watermark centres the logo for an unknown position", async () => {
  const res = await request(app)
    .post("/api/pdf/watermark")
    .attach("file", threePages, "doc.pdf")
    .attach("logo", PNG, "logo.png")
    .field("logoPosition", "middle-left")
    .buffer(true)
    .parse(binary);
  assert.strictEqual(res.status, 200);
  const [img] = await findImages(res.body);
  assert.ok(near(img.x, (612 - 183.6) / 2), `x ${img.x}`);
  assert.ok(near(img.y, (792 - 183.6) / 2), `y ${img.y}`);
});

test("watermark still works with text only", async () => {
  const res = await request(app)
    .post("/api/pdf/watermark")
    .attach("file", threePages, "doc.pdf")
    .field("text", "SAMPLE")
    .buffer(true)
    .parse(binary);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await findText(res.body, "SAMPLE")).length, 3);
});

test("watermark needs text or a logo", async () => {
  const res = await request(app)
    .post("/api/pdf/watermark")
    .attach("file", threePages, "doc.pdf");
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(res.body, {
    error: "Missing parameter",
    message: "Enter watermark text or add a logo",
  });
});

test("watermark rejects a logo that isn't PNG or JPG", async () => {
  const res = await request(app)
    .post("/api/pdf/watermark")
    .attach("file", threePages, "doc.pdf")
    .attach("logo", Buffer.from("GIF89a not really"), "logo.gif");
  assert.strictEqual(res.status, 400);
  assert.match(res.body.message, /PNG or JPG/);
});

const merge = (files) => {
  const req = request(app).post("/api/pdf/merge").buffer(true).parse(binary);
  for (const [buf, name] of files) req.attach("pdfs", buf, name);
  return req;
};

test("merge combines every uploaded PDF in order", async () => {
  const res = await merge([
    [threePages, "a.pdf"],
    [await makePdf(["Four"]), "b.pdf"],
  ]);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await findText(res.body, "Four")).map((h) => h.page), [4]);
});

test("merge opens a PDF that only restricts permissions", async () => {
  // Empty user password: any reader opens it without asking.
  const restricted = await encryptPdfBuffer(await makePdf(["Four"]), "", "owner-secret");
  const res = await merge([
    [threePages, "a.pdf"],
    [restricted, "restricted.pdf"],
  ]);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await findText(res.body, "Four")).map((h) => h.page), [4]);
});

test("merge names the PDF that needs a password", async () => {
  const locked = await encryptPdfBuffer(await makePdf(["Four"]), "secret");
  const res = await request(app)
    .post("/api/pdf/merge")
    .attach("pdfs", threePages, "a.pdf")
    .attach("pdfs", locked, "Locked report.pdf");
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, "PASSWORD_PROTECTED");
  assert.match(res.body.message, /^"Locked report\.pdf" is password-protected/);
});

test("pdf-to-png with allPages returns one file per page", async () => {
  const res = await request(app)
    .post("/api/convert/pdf-to-png")
    .attach("file", threePages, "My Report.pdf")
    .field("allPages", "true");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.totalPages, 3);
  assert.deepStrictEqual(
    res.body.files.map((f) => f.filename),
    ["My Report_page_1.png", "My Report_page_2.png", "My Report_page_3.png"],
  );
  for (const f of res.body.files) {
    const onDisk = path.join(OUTPUTS_DIR, path.basename(new URL(f.url).pathname));
    const head = fs.readFileSync(onDisk).subarray(0, 4);
    assert.deepStrictEqual([...head], [0x89, 0x50, 0x4e, 0x47]);
  }
});

test("pdf-to-jpg without allPages still returns a single JPEG", async () => {
  const res = await request(app)
    .post("/api/convert/pdf-to-jpg")
    .attach("file", threePages, "doc.pdf")
    .buffer(true)
    .parse(binary);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["content-type"], "image/jpeg");
  assert.deepStrictEqual([...res.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});
