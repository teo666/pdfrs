// End-to-end tests for the pure pdf-model classes (PdfDocument/PdfEditor).
// They're DOM-free themselves, but depend on the real Worker/wasm module via
// pdfrs-worker-client.ts, so they're driven from a real browser page
// (www/model-test.html, which exposes window.__pdfModel) rather than a
// Node-only unit test runner.
//
// Run with `pnpm test:model` (starts its own Vite dev server on port 5184).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const wwwRoot = path.resolve(dirname, "..");
const fixtures = path.resolve(wwwRoot, "../tests/fixtures");
const port = 5184;
const baseUrl = `http://localhost:${port}/model-test.html`;

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for dev server at ${url}`);
}

const viteBin = path.join(wwwRoot, "node_modules", ".bin", "vite");
const vite = spawn(viteBin, ["--port", String(port), "--strictPort"], {
  cwd: wwwRoot,
  stdio: "ignore",
});

async function main() {
  await waitForServer(baseUrl, 20_000);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__pdfModel));

  const fs = await import("node:fs/promises");
  const readFixture = async (name) => Array.from(await fs.readFile(path.join(fixtures, name)));

  const fourPagesBytes = await readFixture("four_pages.pdf");
  const tenPagesBytes = await readFixture("ten_pages.pdf");
  const twoPagesBytes = await readFixture("two_pages.pdf");
  const onePageBytes = await readFixture("one_page.pdf");
  const photoJpgBytes = await readFixture("photo.jpg");

  const results = {};

  // --- open() reads the correct page count ---
  results["open() reads correct page count"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    return doc.getPageCount() === 4;
  }, fourPagesBytes);

  // --- rotatePage accumulates, resetRotation clears ---
  results["rotatePage accumulates, resetRotation clears"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.rotatePage(1, 90);
    doc.rotatePage(1, 90);
    const afterTwoRotations = doc.pages().find((p) => p.id === 1)?.pendingRotation === 180;
    doc.resetRotation(1);
    const afterReset = doc.pages().find((p) => p.id === 1)?.pendingRotation === 0;
    return afterTwoRotations && afterReset;
  }, fourPagesBytes);

  // --- rotatePage rejects a non-multiple of 90 ---
  results["rotatePage rejects a non-multiple of 90"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    try {
      doc.rotatePage(1, 45);
      return false;
    } catch {
      return true;
    }
  }, fourPagesBytes);

  // --- deletePage/restorePage toggle markedForDeletion without touching pageCount ---
  results["deletePage/restorePage toggle markedForDeletion, pageCount unchanged before commit"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      doc.deletePage(2);
      const deleted = doc.pages().find((p) => p.id === 2)?.markedForDeletion === true;
      const pageCountUnchanged = doc.getPageCount() === 4;
      doc.restorePage(2);
      const restored = doc.pages().find((p) => p.id === 2)?.markedForDeletion === false;
      return deleted && pageCountUnchanged && restored;
    },
    fourPagesBytes,
  );

  // --- getPreview returns a valid PNG with the right pending metadata ---
  results["getPreview returns a valid PNG with pending metadata"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.rotatePage(1, 90);
    const preview = await doc.getPreview(1, 0.5);
    const isPng =
      preview.png[0] === 0x89 &&
      preview.png[1] === 0x50 &&
      preview.png[2] === 0x4e &&
      preview.png[3] === 0x47;
    return isPng && preview.pendingRotation === 90 && preview.markedForDeletion === false;
  }, fourPagesBytes);

  // --- getPreviews on a document above the pool threshold renders every page ---
  results["getPreviews renders one entry per page (pool path)"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const previews = await doc.getPreviews(0.3);
    return previews.length === 10 && previews.every((p, index) => p.id === index + 1 && p.png.length > 0);
  }, tenPagesBytes);

  // --- Preview cache: same (page, scale) on an unchanged baseline returns
  // the identical PNG reference the second time - proof no re-render
  // happened, not just that the bytes look the same. ---
  results["getPreview caches by (page, scale): identical reference on second call"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      const first = await doc.getPreview(1, 0.3);
      const second = await doc.getPreview(1, 0.3);
      return first.png === second.png;
    },
    fourPagesBytes,
  );

  results["rotatePage/deletePage do not invalidate the preview cache"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const before = await doc.getPreview(1, 0.3);
    doc.rotatePage(1, 90);
    doc.deletePage(2);
    const after = await doc.getPreview(1, 0.3);
    return before.png === after.png;
  }, fourPagesBytes);

  results["commit() invalidates the preview cache (baseline changed)"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const before = await doc.getPreview(1, 0.3);
    doc.rotatePage(3, 90);
    doc.deletePage(2);
    await doc.commit();
    const after = await doc.getPreview(1, 0.3); // still page 1, but the baseline bytes changed
    return before.png !== after.png;
  }, fourPagesBytes);

  results["getPreviews reuses the cache on a repeated call (pool path included)"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      const first = await doc.getPreviews(0.3);
      const second = await doc.getPreviews(0.3);
      return first.every((p, index) => p.png === second[index].png);
    },
    tenPagesBytes,
  );

  // --- onProgress: fires once per page, done increases monotonically to total, final call is (total, total) ---
  results["getPreviews onProgress reports one tick per page, ending at total/total"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      const ticks = [];
      await doc.getPreviews(0.3, { onProgress: (done, total) => ticks.push([done, total]) });

      const allTotalsMatch = ticks.every(([, total]) => total === 10);
      const doneIsMonotonic = ticks.every(([done], i) => i === 0 || done > ticks[i - 1][0]);
      const oneTickPerPage = ticks.length === 10;
      const endsAtTotal = ticks.at(-1)?.[0] === 10;

      return allTotalsMatch && doneIsMonotonic && oneTickPerPage && endsAtTotal;
    },
    tenPagesBytes,
  );

  // --- onProgress on a fully-cached call: still reports one tick per page (cache hits count as "done" too) ---
  results["getPreviews onProgress reports cache hits too, on a fully cached call"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      await doc.getPreviews(0.3); // populate the cache
      const ticks = [];
      await doc.getPreviews(0.3, { onProgress: (done, total) => ticks.push([done, total]) });
      return ticks.length === 4 && ticks.at(-1)?.[0] === 4;
    },
    fourPagesBytes,
  );

  // --- Windowed rendering: only the requested range is rendered, in range order ---
  results["getPreviews with a range renders only that window, in order"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const window_ = await doc.getPreviews(0.3, { range: { start: 3, end: 5 } });
    return window_.length === 3 && window_.map((p) => p.id).join(",") === "3,4,5";
  }, tenPagesBytes);

  // --- Windowed rendering rejects an out-of-bounds range instead of silently clamping ---
  results["getPreviews rejects a range that reaches past the last page"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    try {
      await doc.getPreviews(0.3, { range: { start: 8, end: 12 } });
      return false;
    } catch {
      return true;
    }
  }, tenPagesBytes);

  // --- commit() with a deletion and a rotation combined: rotation must land
  // on the *new* position of the surviving page, not its original id. ---
  results["commit() remaps rotation to the new page position after a deletion"] = await page.evaluate(
    async (bytes) => {
      // Reads a PNG's (width, height) straight from its IHDR chunk (bytes
      // 16..24, big-endian) - good enough to detect a 90/270 rotation
      // (width/height swap) without pulling in an image-decoding library.
      const pngSize = (png) => ({
        width: (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19],
        height: (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23],
      });

      const { PdfDocument } = window.__pdfModel;

      const reference = await PdfDocument.open(new Uint8Array(bytes));
      const unrotatedSize = pngSize((await reference.getPreview(3, 0.3)).png);

      const doc = await PdfDocument.open(new Uint8Array(bytes));
      doc.deletePage(2); // pages 1,3,4 survive, in that order -> new positions 1,2,3
      doc.rotatePage(3, 90); // original page 3 -> new position 2

      await doc.commit();

      if (doc.getPageCount() !== 3) return false;
      if (doc.hasPendingChanges()) return false;

      const rotatedSize = pngSize((await doc.getPreview(2, 0.3)).png); // new position 2 = old page 3
      const untouchedSize = pngSize((await doc.getPreview(1, 0.3)).png); // new position 1 = old page 1, never rotated

      const rotationApplied = rotatedSize.width === unrotatedSize.height && rotatedSize.height === unrotatedSize.width;
      const otherPageUntouched = untouchedSize.width === unrotatedSize.width && untouchedSize.height === unrotatedSize.height;

      return rotationApplied && otherPageUntouched;
    },
    fourPagesBytes,
  );

  // --- movePage: reorders pages() without touching pageCount/rotations/deletions, no wasm call ---
  results["movePage reorders pages() in memory only"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.movePage(3, 0); // move original page 3 to the front
    const order = doc.pages().map((p) => p.id);
    return order.join(",") === "3,1,2,4" && doc.getPageCount() === 4 && !doc.hasPendingChanges();
  }, fourPagesBytes);

  results["movePage clamps an out-of-range target index instead of throwing"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.movePage(1, 999);
    return doc.pages().map((p) => p.id).join(",") === "2,3,4,1";
  }, fourPagesBytes);

  results["movePage rejects a nonexistent page id"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    try {
      doc.movePage(99, 0);
      return false;
    } catch {
      return true;
    }
  }, fourPagesBytes);

  // --- commit() applies the reorder for real, and a rotation pending on the
  // moved page follows it to its new position (same remapping logic as
  // deletion above, exercised here via reordering instead). ---
  results["commit() applies a pending reorder, with rotation following the moved page"] = await page.evaluate(
    async (bytes) => {
      const pngSize = (png) => ({
        width: (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19],
        height: (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23],
      });

      const { PdfDocument } = window.__pdfModel;

      const reference = await PdfDocument.open(new Uint8Array(bytes));
      const unrotatedSize = pngSize((await reference.getPreview(3, 0.3)).png);

      const doc = await PdfDocument.open(new Uint8Array(bytes));
      doc.movePage(3, 0); // order becomes [3, 1, 2, 4]
      doc.rotatePage(3, 90); // page 3 should land rotated at its new position: 1

      await doc.commit();

      if (doc.getPageCount() !== 4) return false;
      if (doc.hasPendingChanges()) return false;

      const movedAndRotated = pngSize((await doc.getPreview(1, 0.3)).png); // position 1 = old page 3, rotated
      const followingPage = pngSize((await doc.getPreview(2, 0.3)).png); // position 2 = old page 1, untouched

      const rotationFollowedTheMove =
        movedAndRotated.width === unrotatedSize.height && movedAndRotated.height === unrotatedSize.width;
      const otherPageUntouched =
        followingPage.width === unrotatedSize.width && followingPage.height === unrotatedSize.height;

      return rotationFollowedTheMove && otherPageUntouched;
    },
    fourPagesBytes,
  );

  // --- commit() resets the order back to identity for the new baseline ---
  results["commit() resets page order to identity after applying a reorder"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.movePage(3, 0);
    await doc.commit();
    return doc.pages().map((p) => p.id).join(",") === "1,2,3,4";
  }, fourPagesBytes);

  // --- exportBytes() does not mutate pending state ---
  results["exportBytes() does not clear pending changes"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.deletePage(1);
    await doc.exportBytes();
    return doc.hasPendingChanges() === true && doc.getPageCount() === 4;
  }, fourPagesBytes);

  // --- PdfEditor.mergeDocuments / splitDocument register new documents with the right page counts ---
  results["PdfEditor.mergeDocuments produces a new document with the summed page count"] = await page.evaluate(
    async ({ bytesA, bytesB }) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const idA = await editor.addDocument(new Uint8Array(bytesA));
      const idB = await editor.addDocument(new Uint8Array(bytesB));
      const mergedId = await editor.mergeDocuments([idA, idB]);
      return editor.getDocument(mergedId).getPageCount() === 3;
    },
    { bytesA: twoPagesBytes, bytesB: onePageBytes },
  );

  results["PdfEditor.splitDocument registers one new document per range"] = await page.evaluate(async (bytes) => {
    const { PdfEditor } = window.__pdfModel;
    const editor = new PdfEditor();
    const id = await editor.addDocument(new Uint8Array(bytes));
    const partIds = await editor.splitDocument(id, [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    return (
      partIds.length === 2 &&
      editor.getDocument(partIds[0]).getPageCount() === 2 &&
      editor.getDocument(partIds[1]).getPageCount() === 2
    );
  }, fourPagesBytes);

  // --- PdfDocument.fromImage: native page size matches the JPEG's own pixel dimensions ---
  results["PdfDocument.fromImage (native) matches the image's pixel size"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.fromImage(new Uint8Array(bytes));
    if (doc.getPageCount() !== 1) return false;
    const preview = await doc.getPreview(1, 1.0);
    // At scale 1.0 the rendered PNG should be the same pixel size as the source JPEG (400x300, see gen_fixtures.rs).
    const width = (preview.png[16] << 24) | (preview.png[17] << 16) | (preview.png[18] << 8) | preview.png[19];
    const height = (preview.png[20] << 24) | (preview.png[21] << 16) | (preview.png[22] << 8) | preview.png[23];
    return width === 400 && height === 300;
  }, photoJpgBytes);

  // --- PdfDocument.fromImage rejects non-JPEG input instead of producing a broken document ---
  results["PdfDocument.fromImage rejects non-JPEG bytes"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    try {
      await PdfDocument.fromImage(new Uint8Array(bytes));
      return false;
    } catch {
      return true;
    }
  }, onePageBytes);

  // --- The actual point of this feature: an image-derived document merges
  // seamlessly with a real PDF document, through PdfEditor, same as any two
  // PDFs would. ---
  results["PdfEditor.addImage produces a document mergeable with a real PDF"] = await page.evaluate(
    async ({ photoBytes, pdfBytes }) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const imageId = await editor.addImage(new Uint8Array(photoBytes));
      const pdfId = await editor.addDocument(new Uint8Array(pdfBytes));
      if (editor.getDocument(imageId).getPageCount() !== 1) return false;

      const mergedId = await editor.mergeDocuments([imageId, pdfId]);
      const merged = editor.getDocument(mergedId);
      if (merged.getPageCount() !== 2) return false;

      // Rendering the merged document's first page (the image) proves the
      // embedded JPEG survived merge_pdfs's Document::compress() call intact.
      const preview = await merged.getPreview(1, 0.3);
      return preview.png.length > 0;
    },
    { photoBytes: photoJpgBytes, pdfBytes: onePageBytes },
  );

  results["no console/page errors"] = consoleErrors.length === 0;

  await browser.close();

  let ok = true;
  for (const [label, passed] of Object.entries(results)) {
    console.log(`${passed ? "PASS" : "FAIL"} - ${label}`);
    ok &&= passed;
  }
  if (consoleErrors.length > 0) {
    console.log("console errors:", consoleErrors);
  }

  return ok;
}

let ok = false;
try {
  ok = await main();
} finally {
  vite.kill();
}

console.log(ok ? "PDF_MODEL_OK" : "PDF_MODEL_FAILED");
process.exit(ok ? 0 : 1);
