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

  // --- The pool's workers hold the document: its bytes go to each worker at
  // most once, not with every page - not even at a new scale, or for a
  // single page. And what they render from what they hold is the right
  // document: the same pixels as a fresh copy of its bytes.
  results["pool workers are sent a document once each, not once per page"] = await page.evaluate(
    async ([ten, photo]) => {
      const { PdfDocument } = window.__pdfModel;
      const sent = () => window.__pdfrsPreviewBytesSent ?? 0;
      const doc = await PdfDocument.open(new Uint8Array(ten));
      const before = sent();
      await doc.getPreviews(0.35);
      await doc.getPreviews(0.45);
      const afterTwenty = sent() - before;
      await doc.getPreview(7, 0.55);
      const afterOne = sent() - before - afterTwenty;
      const pool = window.__pdfrsLastPreviewPoolSize ?? 0;

      // Two documents in turn, then each checked against a fresh copy.
      const other = await PdfDocument.fromImage(new Uint8Array(photo));
      const mixed = [await other.getPreview(1, 0.33), await doc.getPreview(1, 0.33)];
      const fresh = [
        await (await PdfDocument.fromImage(new Uint8Array(photo))).getPreview(1, 0.33),
        await (await PdfDocument.open(new Uint8Array(ten))).getPreview(1, 0.33),
      ];
      const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      return (
        afterTwenty >= 1 &&
        afterTwenty <= pool &&
        afterOne === 0 &&
        mixed.every((preview, i) => same(preview.png, fresh[i].png)) &&
        !same(mixed[0].png, mixed[1].png)
      );
    },
    [tenPagesBytes, photoJpgBytes],
  );

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
    // In memory only - nothing is sent to wasm - but it *is* a pending
    // change: exportBytes()/commit() have to apply the new order.
    return order.join(",") === "3,1,2,4" && doc.getPageCount() === 4 && doc.hasPendingChanges();
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

  // --- protectDocument: a locked copy (no pages, encrypted bytes), the
  // source untouched; unlockDocument: a readable copy with either password,
  // a wrong one rejected as such. The protected copy is the document as it
  // looks now (pending deletion applied).
  results["protectDocument / unlockDocument round trip, as new documents"] = await page.evaluate(
    async (bytes) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const sourceId = await editor.addDocument(new Uint8Array(bytes));
      const source = editor.getDocument(sourceId);
      source.deletePage(2);

      const lockedId = await editor.protectDocument(sourceId, "segreta", "padrone");
      const locked = editor.getDocument(lockedId);
      const text = new TextDecoder("latin1").decode(locked.getBytes());

      let wrong = "";
      try {
        await editor.unlockDocument(lockedId, "sbagliata");
      } catch (err) {
        wrong = err.name;
      }
      const byUser = editor.getDocument(await editor.unlockDocument(lockedId, "segreta"));
      const byOwner = editor.getDocument(await editor.unlockDocument(lockedId, "padrone"));
      const preview = await byUser.getPreview(1, 0.3);

      let twice = false;
      try {
        await editor.protectDocument(lockedId, "ancora");
      } catch {
        twice = true;
      }
      return (
        locked.isLocked() &&
        locked.getPageCount() === 0 &&
        text.includes("/Encrypt") &&
        source.getPageCount() === 4 &&
        source.hasPendingChanges() &&
        !source.isLocked() &&
        wrong === "WrongPasswordError" &&
        !byUser.isLocked() &&
        byUser.getPageCount() === 3 &&
        byOwner.getPageCount() === 3 &&
        preview.png.length > 0 &&
        twice
      );
    },
    fourPagesBytes,
  );

  // --- Images already in the PDF: listed with where they're drawn,
  // extracted (the JPEG byte for byte, or a scaled PNG thumbnail), removed
  // as a pending, undoable edit that leaves the exported file lighter -
  // and still applied after pages are inserted meanwhile.
  results["getImages / extractImage / removeImages, through commit and insertPages"] = await page.evaluate(
    async ([photo, four]) => {
      const { PdfEditor, PdfDocument } = window.__pdfModel;
      const editor = new PdfEditor();
      const imageId = await editor.addImage(new Uint8Array(photo));
      const textId = await editor.addDocument(new Uint8Array(four));
      const doc = editor.getDocument(await editor.mergeDocuments([imageId, textId]));

      const { images, placements } = await doc.getImages();
      const [placement] = placements;
      const fullPage = placement.x < 0.01 && placement.y < 0.01 && placement.width > 0.99 && placement.height > 0.99;

      const jpeg = await doc.extractImage(images[0].key);
      const same = jpeg.mime === "image/jpeg" && jpeg.bytes.length === photo.length && jpeg.bytes.every((b, i) => b === photo[i]);
      const thumb = await doc.extractImage(images[0].key, 16);

      doc.removeImages([placement.id]);
      const label = doc.history().at(-1).label;
      const pending = doc.hasPendingChanges() && doc.pendingImageRemovals().has(placement.id);
      doc.undo();
      const undone = !doc.hasPendingChanges();
      doc.redo();

      const baselineSize = doc.getBytes().length;
      const exported = await doc.exportBytes();
      const after = await (await PdfDocument.open(exported)).getImages();

      // Pages inserted while the removal waits: still applied at commit.
      await doc.insertPages(new Uint8Array(four));
      await doc.commit();
      const committed = await doc.getImages();

      return (
        images.length === 1 &&
        images[0].format === "jpeg" &&
        placements.length === 1 &&
        placement.page === 1 &&
        fullPage &&
        same &&
        thumb.mime === "image/png" &&
        Math.max(thumb.width, thumb.height) <= 16 &&
        label === "Rimuovi immagine (pagina 1)" &&
        pending &&
        undone &&
        after.images.length === 0 &&
        exported.length < baselineSize - photo.length / 2 &&
        committed.images.length === 0 &&
        doc.getPageCount() === 9
      );
    },
    [photoJpgBytes, fourPagesBytes],
  );

  // --- Phase 2: an image replaced by another picture (applied at once,
  // undoable, previews of its pages redrawn; other proportions fitted in the
  // old box), and a lighter copy with the images recompressed.
  results["replaceImage puts another picture in the image's place, undoably"] = await page.evaluate(
    async (photo) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const doc = editor.getDocument(await editor.addImage(new Uint8Array(photo)));
      const before = (await doc.getImages()).images[0];
      const previewBefore = (await doc.getPreview(1, 0.2)).png;

      // A blue square PNG in place of the 4:3 photo.
      const canvas = new OffscreenCanvas(90, 90);
      const context = canvas.getContext("2d");
      context.fillStyle = "#0000ff";
      context.fillRect(0, 0, 90, 90);
      const square = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());

      await doc.replaceImage(before.key, square);
      const after = (await doc.getImages()).images[0];
      const previewAfter = (await doc.getPreview(1, 0.2)).png;
      const label = doc.history().at(-1).label;
      const action = doc.history().at(-1).action;
      doc.undo();
      const undone = (await doc.getImages()).images[0];

      return (
        after.key === before.key &&
        after.width === 120 &&
        after.height === 90 &&
        after.hasMask &&
        previewAfter !== previewBefore &&
        label === "Sostituisci immagine (pagina 1)" &&
        action.type === "replaceImage" &&
        undone.width === before.width &&
        undone.format === "jpeg"
      );
    },
    photoJpgBytes,
  );

  results["compressDocument makes a lighter copy, or none when nothing gets lighter"] = await page.evaluate(
    async (four) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      // A heavy photo: 2000×1500 grainy pixels, at JPEG quality 0.95, on an A4 page.
      const canvas = new OffscreenCanvas(2000, 1500);
      const context = canvas.getContext("2d");
      const pixels = context.createImageData(2000, 1500);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const grain = Math.floor(Math.random() * 48);
        pixels.data[i] = 150 + grain;
        pixels.data[i + 1] = 90 + (grain >> 1);
        pixels.data[i + 2] = 60;
        pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
      const photoId = await editor.addImage(jpeg, { pageSize: "a4", orientation: "auto", margin: 0 });
      const original = editor.getDocument(photoId).getBytes();

      const result = await editor.compressDocument(photoId, "balanced");
      const copy = result.id === null ? null : editor.getDocument(result.id);
      const textOnly = await editor.compressDocument(await editor.addDocument(new Uint8Array(four)));

      return (
        copy !== null &&
        result.recompressed === 1 &&
        result.bytesAfter < result.bytesBefore / 2 &&
        copy.getBytes().length === result.bytesAfter &&
        copy.getPageCount() === 1 &&
        editor.getDocument(photoId).getBytes() === original &&
        textOnly.id === null &&
        textOnly.considered === 0 &&
        textOnly.bytesAfter === textOnly.bytesBefore
      );
    },
    fourPagesBytes,
  );

  // --- Photo pages remember their JPEG: put on another page later (one
  // undo step, pending edits following the new page), kept through a
  // commit, an insertion and a merge.
  results["setPhotoPage remakes a photo page on another page size, undoably"] = await page.evaluate(
    async ([photo, four]) => {
      const { PdfEditor, PdfDocument } = window.__pdfModel;
      const pngWidth = (png) => new DataView(png.buffer, png.byteOffset).getUint32(16);
      const a4 = { pageSize: "a4", orientation: "auto", margin: 28.35 };
      const editor = new PdfEditor();
      const id = await editor.addImage(new Uint8Array(photo), a4);
      const doc = editor.getDocument(id);
      const startsOnA4 = doc.photoPages().get(1)?.pageSize === "a4";
      const a4Width = pngWidth((await doc.getPreview(1, 1)).png);

      doc.rotatePage(1, 90);
      const replaced = await doc.setPhotoPage(1, { pageSize: "native" });
      const [shown] = doc.pages();
      const followed =
        shown.id === replaced && shown.pendingRotation === 90 && shown.originalNumber === 1 && doc.pages().length === 1;
      const label = doc.history().at(-1).label;
      const imagesOnShown = (await doc.getImages()).placements.every((p) => p.page === replaced);
      const nativeWidth = pngWidth((await doc.getPreview(replaced, 1)).png);

      doc.undo();
      const undone = doc.pages()[0].id === 1 && doc.photoPages().get(1)?.pageSize === "a4";
      doc.redo();
      doc.rotatePage(replaced, -90); // back upright: the commit keeps the photo
      await doc.commit();
      const kept = doc.getPageCount() === 1 && doc.photoPages().get(1)?.pageSize === "native";

      const otherId = await editor.addDocument(new Uint8Array(four));
      const other = editor.getDocument(otherId);
      const inserted = await other.insertImage(new Uint8Array(photo), { pageSize: "letter" }, 0);
      const insertedOk =
        other.pages()[0].id === inserted &&
        other.pages()[0].originalNumber === null &&
        other.pages()[1].originalNumber === 1 &&
        other.photoPages().get(inserted)?.pageSize === "letter";

      const merged = editor.getDocument(await editor.mergeDocuments([id, otherId], { applyPending: true }));
      const carried = merged.photoPages().size === 2;

      return (
        startsOnA4 &&
        a4Width > 800 &&
        followed &&
        label === "Foto a dimensione reale (pagina 1)" &&
        imagesOnShown &&
        nativeWidth === 400 &&
        undone &&
        kept &&
        insertedOk &&
        carried
      );
    },
    [photoJpgBytes, fourPagesBytes],
  );

  // --- The outline: read, and written back wherever the page operations
  // underneath would drop it - applying deletions and a reorder, exporting
  // some pages, inserting pages, putting a photo on another page - and
  // turned into one branch per document in a merge.
  results["outline is kept through page edits, exports, inserts and merges"] = await page.evaluate(
    async ([ten, photo]) => {
      const { PdfEditor, PdfDocument, read_outline, write_outline } = window.__pdfModel;
      const titled = await write_outline(new Uint8Array(ten), [
        { title: "Uno", level: 1, page: 1, open: true },
        { title: "Due", level: 2, page: 2, open: true },
        { title: "Dentro due", level: 3, page: 3, open: true },
        { title: "Cinque", level: 1, page: 5, open: false },
      ]);
      const editor = new PdfEditor();
      const id = await editor.addDocument(titled);
      const doc = editor.getDocument(id);
      const titles = (entries) => entries.map((e) => `${e.level}:${e.title}@${e.page ?? "-"}`).join(" ");

      const read = titles(await doc.getOutline());

      // Export pages 5 and 2: only their entries, renumbered; "Dentro due" (page 3) moves up under nothing.
      const exported = titles(await read_outline(await doc.exportPages([5, 2])));

      // Delete page 2, move page 5 first, apply.
      doc.deletePage(2);
      doc.movePage(5, 0);
      const shown = titles(await doc.getOutlineAsShown());
      await doc.commit();
      const committed = titles(await doc.getOutline());
      const inFile = titles(await read_outline(doc.getBytes()));
      doc.undo();
      const undone = titles(await doc.getOutline());
      doc.redo();

      // Inserting pages keeps it.
      await doc.insertPages(new Uint8Array(ten));
      const afterInsert = titles(await read_outline(doc.getBytes()));

      // A merge: a branch per document, named.
      const photoId = await editor.addImage(new Uint8Array(photo), { pageSize: "a4" });
      const merged = editor.getDocument(await editor.mergeDocuments([photoId, id], { applyPending: true, titles: ["Foto", "Testo"] }));
      const mergedOutline = titles(await merged.getOutline());

      // The photo put on another page: its entry follows the new page.
      const replaced = await merged.setPhotoPage(1, { pageSize: "native" });
      const afterPhoto = titles(await read_outline(merged.getBytes()));
      const photoExported = titles(await read_outline(await merged.exportBytes()));

      const original = "1:Uno@1 2:Due@2 3:Dentro due@3 1:Cinque@5";
      // Page 2 gone ("Due" with it, "Dentro due" moving up), page 5 now first.
      const edited = "1:Uno@2 2:Dentro due@3 1:Cinque@1";
      return (
        read === original &&
        exported === "1:Due@2 1:Cinque@1" &&
        shown === edited &&
        committed === edited &&
        inFile === edited &&
        undone === original &&
        afterInsert === edited &&
        mergedOutline === "1:Foto@1 1:Testo@2 2:Uno@3 3:Dentro due@4 2:Cinque@2" &&
        afterPhoto === `1:Foto@${replaced} 1:Testo@2 2:Uno@3 3:Dentro due@4 2:Cinque@2` &&
        photoExported === "1:Foto@1 1:Testo@2 2:Uno@3 3:Dentro due@4 2:Cinque@2"
      );
    },
    [tenPagesBytes, photoJpgBytes],
  );

  // --- Each history step also comes as data (type + params), for a UI to
  // put in its own language; the empty document error is recognisable.
  results["history steps carry a structured action; emptying a document throws EmptyDocumentError"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      doc.rotatePage(2, 90);
      doc.deletePages([1, 3]);
      await doc.setMetadata({ title: "T", author: "A" });
      const actions = doc.history().map((step) => step.action);
      doc.deletePages([2, 4]);
      let emptyError = "";
      try {
        await doc.commit();
      } catch (err) {
        emptyError = err.name;
      }
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      return (
        same(actions, [
          { type: "open", params: {} },
          { type: "rotatePage", params: { page: 2, degrees: 90 } },
          { type: "deletePages", params: { count: 2 } },
          { type: "metadata", params: { fields: "title,author" } },
        ]) && emptyError === "EmptyDocumentError"
      );
    },
    fourPagesBytes,
  );

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

  // --- mergeDocuments carries over already-rendered previews: a page that
  // was previewed in a source document must NOT be re-rendered in the
  // merged result - proven by reference equality (===), not just equal
  // content, same trick as the standalone cache tests above. ---
  results["mergeDocuments transplants cached previews (no re-render for pages already seen)"] = await page.evaluate(
    async ({ bytesA, bytesB }) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const idA = await editor.addDocument(new Uint8Array(bytesA)); // two_pages.pdf
      const idB = await editor.addDocument(new Uint8Array(bytesB)); // one_page.pdf

      // Preview both pages of A and the single page of B *before* merging.
      const aPreviews = await editor.getDocument(idA).getPreviews(0.3);
      const bPreview = await editor.getDocument(idB).getPreview(1, 0.3);

      const mergedId = await editor.mergeDocuments([idA, idB]);
      const merged = editor.getDocument(mergedId);

      // A's pages 1,2 become the merged doc's pages 1,2; B's page 1 becomes page 3.
      const mergedPreviews = await merged.getPreviews(0.3);

      return (
        mergedPreviews[0].png === aPreviews[0].png &&
        mergedPreviews[1].png === aPreviews[1].png &&
        mergedPreviews[2].png === bPreview.png
      );
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

  // --- undo/redo of a pending rotation, and a fresh action truncating redo ---
  results["undo/redo restores a pending rotation"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    if (doc.canUndo() || doc.canRedo()) return false;

    doc.rotatePage(1, 90);
    if (!doc.canUndo()) return false;
    if (!doc.undo()) return false;
    const undone = doc.pages().find((p) => p.id === 1)?.pendingRotation === 0 && !doc.canUndo() && doc.canRedo();

    if (!doc.redo()) return false;
    const redone = doc.pages().find((p) => p.id === 1)?.pendingRotation === 90 && !doc.canRedo();

    // undo() on an empty stack is a no-op returning false, not a throw.
    doc.undo();
    const emptyStackIsNoop = doc.undo() === false;

    return undone && redone && emptyStackIsNoop;
  }, fourPagesBytes);

  results["undo restores the page order"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.movePage(3, 0);
    const moved = doc.pages().map((p) => p.id).join(",") === "3,1,2,4";
    doc.undo();
    return moved && doc.pages().map((p) => p.id).join(",") === "1,2,3,4";
  }, fourPagesBytes);

  // --- The point of snapshotting the whole state (bytes included): a commit
  // is undoable too, and undoing it brings back the pending state it consumed. ---
  results["undo reverts a commit, pending state and all"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.deletePage(2);
    await doc.commit();
    if (doc.getPageCount() !== 3 || doc.hasPendingChanges()) return false;

    if (!doc.undo()) return false;
    const backToFour = doc.getPageCount() === 4;
    const deletionIsPendingAgain = doc.pages().find((p) => p.id === 2)?.markedForDeletion === true;

    if (!doc.redo()) return false;
    return backToFour && deletionIsPendingAgain && doc.getPageCount() === 3;
  }, fourPagesBytes);

  results["a new action after an undo clears redo"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.rotatePage(1, 90);
    doc.undo();
    if (!doc.canRedo()) return false;
    doc.deletePage(3);
    return !doc.canRedo() && doc.canUndo();
  }, fourPagesBytes);

  // --- No-op calls must not leave a history step behind: an undo should
  // always visibly do something. ---
  results["no-op mutations record no history step"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.restorePage(1); // not deleted
    doc.resetRotation(1); // not rotated
    doc.rotatePage(1, 360); // no change to the pending rotation
    doc.movePage(1, 0); // already there
    await doc.commit(); // nothing pending
    return !doc.canUndo();
  }, fourPagesBytes);

  // --- Regression: a reorder alone is a pending change, so exportBytes()
  // must not shortcut back to the untouched baseline. ---
  results["a reorder alone counts as a pending change"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    if (doc.hasPendingChanges()) return false;
    doc.movePage(4, 0);
    if (!doc.hasPendingChanges()) return false;
    const exported = await doc.exportBytes();
    return exported.length > 0 && exported !== doc.getBytes();
  }, fourPagesBytes);

  // --- history(): a labelled, chronological timeline, current state included ---
  results["history() lists every step in order with the current one marked"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const atOpen = doc.history();
    if (atOpen.length !== 1 || atOpen[0].label !== "Documento aperto" || !atOpen[0].current) return false;

    doc.rotatePage(1, 90);
    doc.deletePage(2);
    doc.movePage(3, 0);
    const entries = doc.history();
    const labelsAreDescriptive =
      entries[1].label === "Ruota pagina 1 di +90\u00b0" &&
      entries[2].label === "Elimina pagina 2" &&
      entries[3].label === "Sposta pagina 3 in posizione 1";

    // The current state is the last one, and indexes run 0..n-1 in order.
    const currentIsLast = entries[3].current && entries.findIndex((e) => e.current) === 3;
    const indexesAreOrdered = entries.every((e, i) => e.index === i);

    // After an undo the entry stays in the timeline - ahead of the current one.
    doc.undo();
    const afterUndo = doc.history();
    const futureStepKept = afterUndo.length === 4 && afterUndo[2].current && !afterUndo[3].current;

    return labelsAreDescriptive && currentIsLast && indexesAreOrdered && futureStepKept;
  }, fourPagesBytes);

  results["goToHistoryIndex jumps backwards and forwards over several steps"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.rotatePage(1, 90);
    doc.deletePage(2);
    doc.movePage(3, 0);

    // Straight back to the freshly opened document, three steps at once.
    if (!doc.goToHistoryIndex(0)) return false;
    const backAtStart =
      doc.pages().map((p) => p.id).join(",") === "1,2,3,4" &&
      !doc.hasPendingChanges() &&
      doc.history()[0].current;

    // ...and forward again to a state in the middle.
    if (!doc.goToHistoryIndex(2)) return false;
    const midway =
      doc.pages().find((p) => p.id === 1)?.pendingRotation === 90 &&
      doc.pages().find((p) => p.id === 2)?.markedForDeletion === true &&
      doc.pages().map((p) => p.id).join(",") === "1,2,3,4";

    // Jumping to where we already are reports "nothing moved" instead of throwing.
    const noopJump = doc.goToHistoryIndex(2) === false;

    let rejectedOutOfRange = false;
    try {
      doc.goToHistoryIndex(99);
    } catch {
      rejectedOutOfRange = true;
    }

    return backAtStart && midway && noopJump && rejectedOutOfRange;
  }, fourPagesBytes);

  results["a commit is a labelled history step you can jump back across"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.deletePage(2);
    await doc.commit();
    const labelled = doc.history().at(-1)?.label === "Applica modifiche (3 pagine)";
    doc.goToHistoryIndex(0);
    return labelled && doc.getPageCount() === 4 && !doc.hasPendingChanges();
  }, fourPagesBytes);

  // --- Metadata: pending like every other edit, undoable, applied on commit ---
  results["getMetadata reads the baseline and overlays pending edits"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));

    // four_pages.pdf carries no /Info at all.
    const atOpen = await doc.getMetadata();
    if (Object.keys(atOpen).length !== 0) return false;

    await doc.setMetadata({ title: "Relazione", author: "Sofía Ünal" });
    const overlaid = await doc.getMetadata();
    return overlaid.title === "Relazione" && overlaid.author === "Sofía Ünal" && doc.hasPendingChanges();
  }, fourPagesBytes);

  results["a metadata edit is one undoable history step"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    await doc.getMetadata();

    await doc.setMetadata({ title: "Relazione" });
    const labelled = doc.history().at(-1)?.label === "Modifica metadati (titolo)";

    if (!doc.undo()) return false;
    const undone = Object.keys(await doc.getMetadata()).length === 0 && !doc.hasPendingChanges();

    doc.redo();
    return labelled && undone && (await doc.getMetadata()).title === "Relazione";
  }, fourPagesBytes);

  results["commit writes the metadata into the document"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    await doc.getMetadata();
    await doc.setMetadata({ title: "Relazione", author: "Sofía Ünal" });
    await doc.commit();

    // Re-read from the *new* baseline: the cache was invalidated by commit,
    // so this proves the bytes really carry the metadata now.
    const committed = await doc.getMetadata();
    return committed.title === "Relazione" && committed.author === "Sofía Ünal" && !doc.hasPendingChanges();
  }, fourPagesBytes);

  results["an empty value deletes the field, a no-op edit records no history"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    await doc.getMetadata();
    await doc.setMetadata({ title: "Relazione" });
    await doc.commit();

    const stepsBefore = doc.history().length;
    // Re-typing the same value, and clearing a field that was never set,
    // are both no-ops: neither should leave a history step.
    await doc.setMetadata({ title: "Relazione" });
    await doc.setMetadata({ subject: null });
    const noNewSteps = doc.history().length === stepsBefore;

    await doc.setMetadata({ title: null });
    await doc.commit();
    const cleared = (await doc.getMetadata()).title === undefined;

    return noNewSteps && cleared;
  }, fourPagesBytes);

  // --- Regression: compose_pdf builds a fresh document that carries no
  // /Info, so a commit with a deletion used to silently drop the metadata. ---
  results["metadata survives a commit that also deletes a page"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    await doc.getMetadata();
    await doc.setMetadata({ title: "Relazione" });
    await doc.commit();

    doc.deletePage(2);
    await doc.commit();

    return doc.getPageCount() === 3 && (await doc.getMetadata()).title === "Relazione";
  }, fourPagesBytes);

  // --- Group edits: one undo step for many pages ---
  results["rotatePages/deletePages/restorePages are one history step each"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.rotatePages([1, 3, 3], 90); // the repeated id counts once
    doc.deletePages([2, 4]);
    doc.deletePages([2, 4]); // already marked: no new step
    const labels = doc.history().map((h) => h.label);
    const pages = doc.pages();
    const edited =
      pages[0].pendingRotation === 90 &&
      pages[2].pendingRotation === 90 &&
      pages[1].pendingRotation === 0 &&
      pages[1].markedForDeletion &&
      pages[3].markedForDeletion;
    doc.restorePages([1, 2, 4]); // page 1 isn't marked: skipped
    const restored = doc.pages().every((p) => !p.markedForDeletion);
    doc.undo(); // back to both marked
    const undoneRestore = doc.pages()[1].markedForDeletion && doc.pages()[3].markedForDeletion;
    doc.undo(); // undoes both deletions at once
    const undoneDelete = doc.pages().every((p) => !p.markedForDeletion);
    return (
      edited &&
      restored &&
      undoneRestore &&
      undoneDelete &&
      labels.length === 3 &&
      labels[1] === "Ruota 2 pagine di +90\u00b0" &&
      labels[2] === "Elimina 2 pagine"
    );
  }, tenPagesBytes);

  results["a group edit on a single page reads like the single-page edit"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    doc.rotatePages([2], -90);
    doc.deletePages([3]);
    doc.movePages([4], 0);
    const labels = doc.history().map((h) => h.label);
    return (
      labels[1] === "Ruota pagina 2 di -90\u00b0" &&
      labels[2] === "Elimina pagina 3" &&
      labels[3] === "Sposta pagina 4 in posizione 1"
    );
  }, fourPagesBytes);

  results["movePages moves a non-contiguous selection as one block"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    // 3 and 1 (given out of order) keep their display order 1, 3; the other
    // pages are [2, 4, 5, 6, 7, 8, 9, 10]; index 4 is in front of 6.
    doc.movePages([3, 1], 4);
    const moved = doc.pages().map((p) => p.id).join(",") === "2,4,5,6,1,3,7,8,9,10";
    doc.movePages([1, 3], 4); // already there: no step
    const steps = doc.history().length;
    doc.movePages([9, 10], 999); // clamped to the end: already there too
    doc.movePages([1, 3], 0);
    const front = doc.pages().map((p) => p.id).slice(0, 3).join(",") === "1,3,2";
    doc.undo();
    const undone = doc.pages().map((p) => p.id).join(",") === "2,4,5,6,1,3,7,8,9,10";
    return moved && steps === 2 && front && undone;
  }, tenPagesBytes);

  results["exportPages builds a PDF of those pages, in that order, rotations applied"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      doc.rotatePage(3, 90);
      doc.deletePage(4); // deletions don't matter to an export
      const exported = await PdfDocument.open(await doc.exportPages([3, 1, 4]));
      // The source is untouched.
      const sourceIntact = doc.getPageCount() === 4 && doc.pages()[2].pendingRotation === 90;
      // Page 1 of the export is the old page 3, rotated: rendered landscape.
      const first = await exported.getPreview(1, 0.2);
      const second = await exported.getPreview(2, 0.2);
      const size = async (png) => {
        const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
        return { w: bitmap.width, h: bitmap.height };
      };
      const a = await size(first.png);
      const b = await size(second.png);
      let rejectsEmpty = false;
      try {
        await doc.exportPages([]);
      } catch {
        rejectsEmpty = true;
      }
      return exported.getPageCount() === 3 && sourceIntact && a.w > a.h && b.h > b.w && rejectsEmpty;
    },
    fourPagesBytes,
  );

  results["PdfEditor.extractPages adds a new document and carries over unrotated previews"] = await page.evaluate(
    async (bytes) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const id = await editor.addDocument(new Uint8Array(bytes));
      const source = editor.getDocument(id);
      const preview5 = await source.getPreview(5, 0.3);
      await source.getPreview(2, 0.3);
      source.rotatePage(2, 180);
      const extractedId = await editor.extractPages(id, [5, 2, 7]);
      const extracted = editor.getDocument(extractedId);
      const carried = extracted.cachedEntriesForPage(1).some(([, png]) => png === preview5.png);
      const notCarried = extracted.cachedEntriesForPage(2).length === 0; // page 2 was rotated
      return (
        extracted.getPageCount() === 3 &&
        editor.listDocuments().length === 2 &&
        source.getPageCount() === 10 &&
        carried &&
        notCarried
      );
    },
    tenPagesBytes,
  );

  // --- Moving pages between documents ---
  results["insertPages adds pages to the baseline, keeping pending edits and previews"] = await page.evaluate(
    async ([fourBytes, twoBytes]) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(fourBytes));
      await doc.setMetadata({ title: "Contratto" });
      await doc.commit(); // the title is now in the baseline
      const preview1 = await doc.getPreview(1, 0.2);
      doc.rotatePage(2, 90);

      const ids = await doc.insertPages(new Uint8Array(twoBytes), 1);
      const order = doc.pages().map((p) => p.id).join(",");
      const rotationKept = doc.pages().find((p) => p.id === 2).pendingRotation === 90;
      const cacheKept = (await doc.getPreview(1, 0.2)).png === preview1.png;
      const label = doc.history().at(-1).label;
      const titleKept = (await doc.getMetadata()).title === "Contratto";

      doc.undo();
      const undone = doc.getPageCount() === 4 && doc.pages().map((p) => p.id).join(",") === "1,2,3,4";
      const rotationSurvivesUndo = doc.pages()[1].pendingRotation === 90;
      doc.redo();
      await doc.commit();

      return (
        ids.join(",") === "5,6" &&
        order === "1,5,6,2,3,4" &&
        rotationKept &&
        cacheKept &&
        label === "Inserisci 2 pagine" &&
        titleKept &&
        undone &&
        rotationSurvivesUndo &&
        doc.getPageCount() === 6 &&
        (await doc.getMetadata()).title === "Contratto"
      );
    },
    [fourPagesBytes, twoPagesBytes],
  );

  results["transferPages copies or moves pages into another document"] = await page.evaluate(
    async ([tenBytes, fourBytes]) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const a = await editor.addDocument(new Uint8Array(tenBytes));
      const b = await editor.addDocument(new Uint8Array(fourBytes));
      const source = editor.getDocument(a);
      const target = editor.getDocument(b);
      const preview5 = await source.getPreview(5, 0.3);
      await source.getPreview(3, 0.3);
      source.rotatePage(3, 90);

      const moved = await editor.transferPages(a, [5, 3], b, { move: true });
      const targetOk =
        target.getPageCount() === 6 &&
        moved.join(",") === "5,6" &&
        target.pages().map((p) => p.id).join(",") === "1,2,3,4,5,6" &&
        target.history().at(-1).label === "Inserisci 2 pagine da un altro documento";
      const previewCarried = target.cachedEntriesForPage(5).some(([, png]) => png === preview5.png);
      const rotatedNotCarried = target.cachedEntriesForPage(6).length === 0;
      const sourceMarked = source
        .pages()
        .filter((p) => p.markedForDeletion)
        .map((p) => p.id)
        .join(",") === "3,5";

      // A copy at the front leaves the source alone.
      await editor.transferPages(a, [1], b, { at: 0 });
      const copied = target.pages()[0].id === 7 && !source.pages()[0].markedForDeletion;

      let rejectsSame = false;
      try {
        await editor.transferPages(a, [1], a);
      } catch {
        rejectsSame = true;
      }
      return targetOk && previewCarried && rotatedNotCarried && sourceMarked && copied && rejectsSame;
    },
    [tenPagesBytes, fourPagesBytes],
  );

  results["mergeDocuments with applyPending merges what each document looks like now"] = await page.evaluate(
    async ([fourBytes, twoBytes]) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const a = await editor.addDocument(new Uint8Array(fourBytes));
      const b = await editor.addDocument(new Uint8Array(twoBytes));
      const docA = editor.getDocument(a);
      const preview3 = await docA.getPreview(3, 0.3);
      docA.deletePage(2);
      docA.movePage(4, 0); // shown: 4, 1, 3
      const mergedId = await editor.mergeDocuments([a, b], { applyPending: true });
      const merged = editor.getDocument(mergedId);
      // Page 3 of A is the third page shown, so the third of the result.
      const carried = merged.cachedEntriesForPage(3).some(([, png]) => png === preview3.png);
      return merged.getPageCount() === 5 && carried && docA.getPageCount() === 4;
    },
    [fourPagesBytes, twoPagesBytes],
  );

  // --- Annotations (signatures): pending, undoable, applied on export ---
  // Helpers shared by the annotation tests, defined once in the page.
  await page.evaluate(() => {
    window.__redSquare = (size = 8) => {
      const pixels = new Uint8Array(size * size * 4);
      for (let i = 0; i < pixels.length; i += 4) pixels.set([220, 0, 0, 255], i);
      return { pixels, width: size, height: size };
    };
    // RGBA of the pixel at (fx, fy) - fractions of the page - in a rendered PNG.
    window.__pixelAt = async (png, fx, fy) => {
      const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const x = Math.floor(fx * bitmap.width);
      const y = Math.floor(fy * bitmap.height);
      return Array.from(context.getImageData(x, y, 1, 1).data);
    };
    window.__isRed = ([r, g, b]) => r > 180 && g < 60 && b < 60;
    // Share of red pixels in a rectangle given in fractions of the page.
    window.__redShare = async (png, x0, y0, x1, y1) => {
      const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const left = Math.floor(x0 * bitmap.width);
      const top = Math.floor(y0 * bitmap.height);
      const width = Math.max(1, Math.floor((x1 - x0) * bitmap.width));
      const height = Math.max(1, Math.floor((y1 - y0) * bitmap.height));
      const { data } = context.getImageData(left, top, width, height);
      let red = 0;
      for (let i = 0; i < data.length; i += 4) if (window.__isRed([data[i], data[i + 1], data[i + 2]])) red += 1;
      return red / (width * height);
    };
  });

  results["annotations are pending, undoable edits with readable history labels"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      const asset = doc.addAsset(window.__redSquare());
      const id = doc.addAnnotation({ page: 2, asset, x: 0.1, y: 0.1, width: 0.3 });
      const pending = doc.hasPendingChanges() && doc.pagesWithAnnotations().has(2);
      doc.updateAnnotation(id, { x: 0.2 });
      doc.updateAnnotation(id, { width: 0.4 });
      doc.updateAnnotation(id, { width: 0.4 }); // unchanged: no step
      const labels = doc.history().map((h) => h.label).slice(1);
      doc.undo();
      const undone = doc.annotations()[0].width === 0.3;
      doc.removeAnnotation(id);
      const removed = doc.annotations().length === 0 && !doc.hasPendingChanges();
      doc.undo();
      const back = doc.annotations().length === 1;

      let rejects = 0;
      for (const bad of [
        () => doc.addAnnotation({ page: 9, asset, x: 0, y: 0, width: 0.2 }),
        () => doc.addAnnotation({ page: 1, asset: 42, x: 0, y: 0, width: 0.2 }),
        () => doc.addAnnotation({ page: 1, asset, x: 0, y: 0, width: 0 }),
        () => doc.addAsset({ pixels: new Uint8Array(3), width: 1, height: 1 }),
      ]) {
        try {
          bad();
        } catch {
          rejects += 1;
        }
      }
      return (
        pending &&
        labels.join(" | ") ===
          "Aggiungi firma a pagina 2 | Sposta firma a pagina 2 | Ridimensiona firma a pagina 2" &&
        undone &&
        removed &&
        back &&
        rejects === 4
      );
    },
    fourPagesBytes,
  );

  results["commit draws the annotation where it was placed and clears it"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const asset = doc.addAsset(window.__redSquare());
    doc.addAnnotation({ page: 1, asset, x: 0.5, y: 0.5, width: 0.4 });
    const before = await doc.getPreview(1, 0.3); // previews show the baseline: not red yet
    const notYet = !window.__isRed(await window.__pixelAt(before.png, 0.7, 0.55));
    await doc.commit();
    const after = await doc.getPreview(1, 0.3);
    const inside = window.__isRed(await window.__pixelAt(after.png, 0.7, 0.55));
    const outside = !window.__isRed(await window.__pixelAt(after.png, 0.3, 0.3));
    return notYet && inside && outside && doc.annotations().length === 0 && !doc.hasPendingChanges();
  }, fourPagesBytes);

  results["annotations follow their page through reorder, deletion and extraction"] = await page.evaluate(
    async (bytes) => {
      const { PdfEditor } = window.__pdfModel;
      const editor = new PdfEditor();
      const id = await editor.addDocument(new Uint8Array(bytes));
      const doc = editor.getDocument(id);
      const asset = doc.addAsset(window.__redSquare());
      // Top-left area of page 3, then page 3 moved first; page 4 deleted with its own annotation.
      doc.addAnnotation({ page: 3, asset, x: 0.05, y: 0.05, width: 0.3 });
      doc.addAnnotation({ page: 4, asset, x: 0.5, y: 0.5, width: 0.3 });
      const cached3 = await doc.getPreview(3, 0.3);
      doc.movePage(3, 0);
      doc.deletePage(4);

      const extractedId = await editor.extractPages(id, [3]);
      const extracted = editor.getDocument(extractedId);
      const notCarried = extracted.cachedEntriesForPage(1).length === 0; // annotated: a new picture
      const extractedPng = (await extracted.getPreview(1, 0.3)).png;
      const extractedRed = window.__isRed(await window.__pixelAt(extractedPng, 0.15, 0.08));

      await doc.commit();
      const first = (await doc.getPreview(1, 0.3)).png;
      const red = window.__isRed(await window.__pixelAt(first, 0.15, 0.08));
      return (
        notCarried &&
        extractedRed &&
        red &&
        doc.getPageCount() === 3 &&
        cached3.png !== first // the committed page is a new render
      );
    },
    fourPagesBytes,
  );

  results["a rotated annotation is drawn turned about its centre"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    // A wide red bar (5:1) across the middle of page 1.
    const pixels = new Uint8Array(40 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([220, 0, 0, 255], i);
    const asset = doc.addAsset({ pixels, width: 40, height: 8 });
    const id = doc.addAnnotation({ page: 1, asset, x: 0.3, y: 0.5, width: 0.4 });
    const defaultsUpright = doc.annotations()[0].rotation === 0;
    doc.updateAnnotation(id, { rotation: 450 }); // normalised to 90
    const label = doc.history().at(-1).label;
    const normalised = doc.annotations()[0].rotation === 90;
    doc.updateAnnotation(id, { rotation: 90 }); // same angle: no step
    const steps = doc.history().length;

    await doc.commit();
    const png = (await doc.getPreview(1, 0.3)).png;
    // Standing upright now: red above the centre, not at the bar's old left end.
    const above = window.__isRed(await window.__pixelAt(png, 0.5, 0.45));
    const oldEnd = window.__isRed(await window.__pixelAt(png, 0.33, 0.52));
    return defaultsUpright && label === "Ruota firma a pagina 1" && normalised && steps === 3 && above && !oldEnd;
  }, fourPagesBytes);

  results["a signature on all pages moves together; an unlinked copy is edited on its own"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      const asset = doc.addAsset(window.__redSquare());
      const id = doc.addAnnotation({ page: 2, asset, x: 0.6, y: 0.8, width: 0.2 });
      const copies = doc.applyAnnotationToAllPages(id);
      const onAll = doc.annotations().map((a) => a.page).sort().join(",") === "1,2,3,4";
      const allLinked = doc.annotations().every((a) => a.linked && a.group === doc.annotations()[0].group);
      const again = doc.applyAnnotationToAllPages(copies[0]).length === 0; // already everywhere

      // Editing any linked copy edits them all, in one step.
      doc.updateAnnotation(copies[1], { x: 0.1, rotation: 30 });
      const together = doc.annotations().every((a) => a.x === 0.1 && a.rotation === 30);
      const moveLabel = doc.history().at(-1).label;

      // Page 3's copy unlinked and moved: only it moves; the others follow
      // their own edits without dragging it along.
      const page3 = () => doc.annotations().find((a) => a.page === 3);
      doc.detachAnnotation(page3().id);
      doc.updateAnnotation(page3().id, { y: 0.1 });
      doc.updateAnnotation(id, { width: 0.3 });
      const others = doc.annotations().filter((a) => a.page !== 3);
      const independent =
        page3().y === 0.1 && page3().width === 0.2 && others.every((a) => a.y === 0.8 && a.width === 0.3);
      const onlyLabel = doc.history().at(-2).label;

      // Linking it back puts it where the others are.
      doc.applyAnnotationToAllPages(page3().id);
      const relinked = page3().linked && page3().y === 0.8 && page3().width === 0.3;

      // Pages inserted later get a copy when applying again.
      await doc.insertPages(new Uint8Array(bytes));
      const added = doc.applyAnnotationToAllPages(id).length === 4;

      // Removing a linked copy removes the linked ones, not an unlinked one.
      doc.detachAnnotation(page3().id);
      doc.removeAnnotation(id);
      const kept = doc.annotations();
      const removed = kept.length === 1 && kept[0].page === 3;

      // A commit draws every copy.
      doc.undo();
      await doc.commit();
      const png = (await doc.getPreview(8, 0.3)).png;
      const drawn = window.__isRed(await window.__pixelAt(png, 0.2, 0.87));

      return (
        copies.length === 3 &&
        onAll &&
        allLinked &&
        again &&
        together &&
        moveLabel === "Ruota firma su 4 pagine" &&
        independent &&
        onlyLabel === "Sposta firma a pagina 3" &&
        relinked &&
        added &&
        removed &&
        drawn
      );
    },
    fourPagesBytes,
  );

  results["an asset's noun names its annotations in the history"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const logo = doc.addAsset(window.__redSquare(), "immagine");
    const id = doc.addAnnotation({ page: 1, asset: logo, x: 0.1, y: 0.1, width: 0.2 });
    doc.updateAnnotation(id, { rotation: 15 });
    doc.applyAnnotationToAllPages(id);
    doc.removeAnnotation(id);
    const signature = doc.addAsset(window.__redSquare()); // default noun
    doc.addAnnotation({ page: 2, asset: signature, x: 0.1, y: 0.1, width: 0.2 });
    return (
      doc.history().slice(1).map((h) => h.label).join(" | ") ===
      "Aggiungi immagine a pagina 1 | Ruota immagine a pagina 1 | Immagine su tutte le pagine (4) | " +
        "Rimuovi immagine da 4 pagine | Aggiungi firma a pagina 2"
    );
  }, fourPagesBytes);

  results["an annotation with an explicit height is drawn stretched"] = await page.evaluate(async (bytes) => {
    const { PdfDocument } = window.__pdfModel;
    const doc = await PdfDocument.open(new Uint8Array(bytes));
    const asset = doc.addAsset(window.__redSquare());
    // A square image at 40% of the width: naturally ~28% of an A4's height.
    const id = doc.addAnnotation({ page: 1, asset, x: 0.3, y: 0.3, width: 0.4 });
    const natural = doc.annotations()[0].height === null;
    doc.updateAnnotation(id, { height: 0.05 }); // squashed into a thin bar
    const label = doc.history().at(-1).label;
    let rejects = false;
    try {
      doc.updateAnnotation(id, { height: -1 });
    } catch {
      rejects = true;
    }
    await doc.commit();
    const png = (await doc.getPreview(1, 0.3)).png;
    const inBar = window.__isRed(await window.__pixelAt(png, 0.5, 0.32));
    const belowBar = window.__isRed(await window.__pixelAt(png, 0.5, 0.45)); // red if it were square
    return natural && label === "Ridimensiona firma a pagina 1" && rejects && inBar && !belowBar;
  }, fourPagesBytes);

  results["text annotations are real text in a standard font, drawn in their box"] = await page.evaluate(
    async (bytes) => {
      const { PdfDocument } = window.__pdfModel;
      const doc = await PdfDocument.open(new Uint8Array(bytes));
      const style = { font: "helvetica", bold: true, italic: false, color: "#dc0000", align: "left" };
      const id = doc.addTextAnnotation({ page: 1, x: 0.1, y: 0.6, width: 0.5, text: { text: "MMMMMM", ...style } });
      doc.applyAnnotationToAllPages(id);
      doc.updateAnnotation(id, { text: { text: "MMMMMMMM", ...style } }); // every linked copy follows
      const labels = doc.history().slice(1).map((h) => h.label);
      const allEdited = doc.annotations().every((a) => a.text.text === "MMMMMMMM");
      let rejectsBlank = false;
      try {
        doc.addTextAnnotation({ page: 1, x: 0, y: 0, width: 0.2, text: { text: "  ", ...style } });
      } catch {
        rejectsBlank = true;
      }

      const exported = await doc.exportBytes();
      const raw = new TextDecoder("latin1").decode(exported);
      const standardFont = /\/BaseFont\s*\/Helvetica-Bold/.test(raw) && !/FontFile/.test(raw);

      await doc.commit();
      const png = (await doc.getPreview(3, 0.3)).png;
      // Inside the box (x 0.1..0.6, starting at y 0.6): plenty of red ink.
      // Right of it and above it: none.
      const inside = (await window.__redShare(png, 0.1, 0.6, 0.6, 0.66)) > 0.15;
      const right = (await window.__redShare(png, 0.62, 0.58, 0.9, 0.7)) > 0;
      const above = (await window.__redShare(png, 0.05, 0.5, 0.65, 0.595)) > 0;
      const checks = {
        labels:
          labels.join(" | ") === "Aggiungi testo a pagina 1 | Testo su tutte le pagine (4) | Modifica testo su 4 pagine",
        allEdited,
        rejectsBlank,
        standardFont,
        inside,
        notRight: !right,
        notAbove: !above,
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length) console.error("text annotation checks failed:", failed.join(", "), labels.join(" | "));
      return failed.length === 0;
    },
    fourPagesBytes,
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
