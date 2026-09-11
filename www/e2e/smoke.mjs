// End-to-end smoke test for the pdfrs test frontend: drives the actual page
// with Playwright (real DOM events, real wasm module) to exercise every panel
// through the same path a human would use it - the wasm-bindgen boundary that
// the Rust unit tests in ../../tests can't cover.
//
// Run with `pnpm test:e2e` (starts its own Vite dev server on port 5183).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import zlib from "node:zlib";
import os from "node:os";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const wwwRoot = path.resolve(dirname, "..");
const fixtures = path.resolve(wwwRoot, "../tests/fixtures");
const port = 5183;
const baseUrl = `http://localhost:${port}/`;

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

// Spawn the local binary directly (not `npx`/`pnpm exec`) so this script
// doesn't depend on which package manager happens to be on PATH.
const viteBin = path.join(wwwRoot, "node_modules", ".bin", "vite");
const vite = spawn(viteBin, ["--port", String(port), "--strictPort"], {
  cwd: wwwRoot,
  stdio: "ignore",
});


/**
 * Builds a tiny PNG with an alpha channel, in-process.
 *
 * Cheaper than carrying a binary fixture around, and it avoids enabling the
 * `png` feature on the Rust side just to *generate* test data (the crate
 * itself never decodes PNGs - the browser does).
 */
function makePngWithAlpha(width, height) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      raw[px] = 255;
      raw[px + 1] = 0;
      raw[px + 2] = 0;
      // Half the pixels transparent, so the image really exercises /SMask.
      raw[px + 3] = x % 2 === 0 ? 255 : 0;
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typeAndData) >>> 0 : crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Fallback for Node versions without zlib.crc32. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
  await page.waitForSelector("text=Merge", { timeout: 10_000 });

  // A terminal status always starts with "Fatto" or "Errore" - not just
  // "anything other than 'In corso…'", since panels with a progress bar
  // (Preview) pass through intermediate "Rendering anteprime… (n/m)" states
  // first, which would otherwise look "settled" too early.
  async function waitForSettledStatus(selector) {
    await page.waitForFunction((sel) => {
      const text = document.querySelector(sel)?.textContent?.trim() ?? "";
      return text.startsWith("Fatto") || text.startsWith("Errore");
    }, selector);
    return (await page.textContent(selector)).trim();
  }

  function readHeartbeat() {
    return page.$eval("#heartbeat-count", (el) => Number(el.textContent));
  }

  // --- Heartbeat: ticks via requestAnimationFrame on the main thread. If it
  // stops advancing while a wasm call is in flight, the UI is blocked - since
  // every call goes through pdfrs.worker.ts, it shouldn't. ---
  const heartbeatBeforeCalls = await readHeartbeat();
  await page.waitForTimeout(100);
  const heartbeatIsTicking = (await readHeartbeat()) > heartbeatBeforeCalls;

  function switchTab(target) {
    return page.click(`#tabs [data-target="${target}"]`);
  }

  // --- Preview: drop two_pages.pdf, expect one thumbnail card per page ---
  await switchTab("panel-preview");
  const heartbeatBeforePreview = await readHeartbeat();
  await page.setInputFiles("#preview-input", [path.join(fixtures, "two_pages.pdf")]);
  const previewStatus = await waitForSettledStatus("#preview-status");
  const previewCardCount = await page.locator("#preview-grid .preview-card").count();
  const heartbeatKeptTickingDuringPreview = (await readHeartbeat()) > heartbeatBeforePreview;

  // --- Preview with a worker pool: ten_pages.pdf has more pages than
  // PARALLEL_PREVIEW_THRESHOLD (6), so this run should fan out across
  // several workers instead of the single shared one used above. Also
  // exercises the progress bar, since a fresh (uncached) 10-page render
  // takes long enough to actually observe it mid-flight. ---
  await page.setInputFiles("#preview-input", [path.join(fixtures, "ten_pages.pdf")]);
  const progressWasShownDuringPreview = await page
    .waitForFunction(() => {
      const progress = document.querySelector("#preview-progress");
      return progress && !progress.hidden;
    })
    .then(() => true)
    .catch(() => false);
  const parallelPreviewStatus = await waitForSettledStatus("#preview-status");
  const progressHiddenAfterPreview = await page.evaluate(
    () => document.querySelector("#preview-progress")?.hidden,
  );
  const parallelPreviewCardCount = await page.locator("#preview-grid .preview-card").count();
  const parallelPreviewImageCount = await page
    .locator("#preview-grid .preview-card img")
    .evaluateAll((imgs) => imgs.filter((img) => img.getAttribute("src")).length);
  const previewPoolSize = await page.evaluate(() => window.__pdfrsLastPreviewPoolSize);

  // --- Merge: two_pages.pdf + one_page.pdf -> expect a download ---
  await switchTab("panel-merge");
  await page.setInputFiles("#merge-input", [
    path.join(fixtures, "two_pages.pdf"),
    path.join(fixtures, "one_page.pdf"),
  ]);
  const [mergeDownload] = await Promise.all([page.waitForEvent("download"), page.click("#merge-run")]);
  const mergeStatus = await waitForSettledStatus("#merge-status");

  // --- Split four_pages.pdf into 1-2 and 3-4 -> expect two downloads ---
  await switchTab("panel-split");
  await page.setInputFiles("#split-input", [path.join(fixtures, "four_pages.pdf")]);
  await page.fill("#split-ranges", "1-2,3-4");
  const splitDownloads = [];
  page.on("download", (d) => {
    if (d.suggestedFilename().startsWith("split-")) splitDownloads.push(d);
  });
  await page.click("#split-run");
  const splitStatus = await waitForSettledStatus("#split-status");

  // --- Rotate one_page.pdf ---
  await switchTab("panel-rotate");
  await page.setInputFiles("#rotate-input", [path.join(fixtures, "one_page.pdf")]);
  await page.fill("#rotate-rotations", "1:90");
  const [rotateDownload] = await Promise.all([page.waitForEvent("download"), page.click("#rotate-run")]);
  const rotateStatus = await waitForSettledStatus("#rotate-status");

  // --- Annota: drop two PNGs (with alpha) onto the pages of four_pages.pdf ---
  await switchTab("panel-annota");
  await page.setInputFiles("#annota-input", [path.join(fixtures, "four_pages.pdf")]);
  const annotaPagesStatus = await waitForSettledStatus("#annota-status");
  await page.setInputFiles("#annota-image-input", [
    { name: "firma.png", mimeType: "image/png", buffer: makePngWithAlpha(40, 20) },
    { name: "timbro.png", mimeType: "image/png", buffer: makePngWithAlpha(20, 20) },
  ]);
  await waitForSettledStatus("#annota-status");
  const annotaAssetCount = await page.locator("#annota-palette .annota-asset").count();

  // Place an image by clicking its palette card, the keyboard-reachable
  // equivalent of dragging it onto the page. The drag itself isn't driven
  // here: Playwright's dragTo jumps the pointer to the target before the drag
  // begins, so the browser picks the page image as the drag source instead of
  // the palette card, and synthetic mouse events don't raise HTML5 drag
  // events at all. The click path exercises the same placement code.
  await page.click("#annota-palette .annota-asset");
  const annotaBoxCount = await page.locator("#annota-stage .annota-box").count();

  // ...and drop the second one at a specific spot. Driven with synthetic
  // DragEvents rather than the mouse: Playwright's dragTo moves the pointer to
  // the target before the drag starts (so the browser picks the page image as
  // the source), and synthetic mouse events raise no HTML5 drag events at all.
  // Dispatching the events directly still exercises the panel's own drop
  // handling - which is the part worth testing.
  const droppedBox = await page.evaluate(() => {
    const card = document.querySelectorAll("#annota-palette .annota-asset")[1];
    const stage = document.querySelector("#annota-stage");
    const rect = document.querySelector("#annota-page-img").getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    const at = { clientX: rect.left + rect.width * 0.65, clientY: rect.top + rect.height * 0.5 };

    card.dispatchEvent(new DragEvent("dragstart", { dataTransfer, bubbles: true }));
    stage.dispatchEvent(new DragEvent("dragover", { dataTransfer, bubbles: true, cancelable: true, ...at }));
    stage.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true, ...at }));
    card.dispatchEvent(new DragEvent("dragend", { dataTransfer, bubbles: true }));

    const boxes = stage.querySelectorAll(".annota-box");
    return boxes.length === 2 ? parseFloat(boxes[1].style.left) : null;
  });

  // ...then replicate it onto every page, and check the badges appear.
  await page.click("#annota-all-pages");
  await waitForSettledStatus("#annota-status");
  const annotaBadges = await page.locator("#annota-pages .count:not([hidden])").count();

  const [annotaDownload] = await Promise.all([page.waitForEvent("download"), page.click("#annota-run")]);
  const annotaStatus = await waitForSettledStatus("#annota-status");

  // --- Compose: interleave pages from two_pages.pdf and one_page.pdf ---
  await switchTab("panel-compose");
  await page.setInputFiles("#compose-input", [
    path.join(fixtures, "two_pages.pdf"),
    path.join(fixtures, "one_page.pdf"),
  ]);
  await page.fill("#compose-layout", "1:1,0:2,0:1");
  const [composeDownload] = await Promise.all([page.waitForEvent("download"), page.click("#compose-run")]);
  const composeStatus = await waitForSettledStatus("#compose-status");

  // --- Encrypt one_page.pdf, then feed the result back into Decrypt ---
  await switchTab("panel-encrypt");
  await page.setInputFiles("#encrypt-input", [path.join(fixtures, "one_page.pdf")]);
  await page.fill("#encrypt-owner", "owner-secret");
  await page.fill("#encrypt-user", "user-secret");
  const [encryptDownload] = await Promise.all([page.waitForEvent("download"), page.click("#encrypt-run")]);
  const encryptStatus = await waitForSettledStatus("#encrypt-status");

  const encryptedPath = path.join(os.tmpdir(), "pdfrs-smoke-encrypted.pdf");
  await encryptDownload.saveAs(encryptedPath);

  // Wrong password -> expect an error surfaced in the status area, no crash.
  await switchTab("panel-decrypt");
  await page.setInputFiles("#decrypt-input", [encryptedPath]);
  await page.fill("#decrypt-password", "wrong-password");
  await page.click("#decrypt-run");
  const wrongPasswordStatus = await waitForSettledStatus("#decrypt-status");

  // Correct password -> expect success and a download.
  await page.fill("#decrypt-password", "user-secret");
  const [decryptDownload] = await Promise.all([page.waitForEvent("download"), page.click("#decrypt-run")]);
  const decryptStatus = await waitForSettledStatus("#decrypt-status");

  await page.screenshot({ path: path.join(dirname, "smoke.png"), fullPage: true });

  // --- Core/full wasm split: a fresh page that only ever touches the six
  // "core" panels (never Preview) must never fetch the "full" package
  // (hayro/image, ~4MB) - proving the lazy-load in pdfrs.worker.ts really is
  // lazy, not just cached-after-first-use by the time we'd check. A second
  // fresh page that does open Preview must fetch it. Both use their own
  // page (not the one above, which already touched Preview earlier). ---
  const isFullPackageRequest = (url) => url.includes("pkg-full") || url.includes("pdfrs-full");

  const corePage = await browser.newPage();
  const coreRequests = [];
  corePage.on("request", (req) => coreRequests.push(req.url()));
  await corePage.goto(baseUrl, { waitUntil: "networkidle" });
  await corePage.waitForSelector("text=Merge", { timeout: 10_000 });

  async function runCorePanel(target, inputSelector, files, runSelector) {
    await corePage.click(`#tabs [data-target="${target}"]`);
    await corePage.setInputFiles(inputSelector, files);
    await Promise.all([corePage.waitForEvent("download"), corePage.click(runSelector)]);
  }

  await runCorePanel(
    "panel-merge",
    "#merge-input",
    [path.join(fixtures, "two_pages.pdf"), path.join(fixtures, "one_page.pdf")],
    "#merge-run",
  );

  await corePage.click('#tabs [data-target="panel-split"]');
  await corePage.setInputFiles("#split-input", [path.join(fixtures, "two_pages.pdf")]);
  await corePage.fill("#split-ranges", "1-1,2-2");
  await Promise.all([corePage.waitForEvent("download"), corePage.click("#split-run")]);

  await corePage.click('#tabs [data-target="panel-rotate"]');
  await corePage.setInputFiles("#rotate-input", [path.join(fixtures, "one_page.pdf")]);
  await corePage.fill("#rotate-rotations", "1:90");
  await Promise.all([corePage.waitForEvent("download"), corePage.click("#rotate-run")]);

  await corePage.click('#tabs [data-target="panel-compose"]');
  await corePage.setInputFiles("#compose-input", [path.join(fixtures, "two_pages.pdf"), path.join(fixtures, "one_page.pdf")]);
  await corePage.fill("#compose-layout", "1:1,0:2,0:1");
  await Promise.all([corePage.waitForEvent("download"), corePage.click("#compose-run")]);

  await corePage.click('#tabs [data-target="panel-encrypt"]');
  await corePage.setInputFiles("#encrypt-input", [path.join(fixtures, "one_page.pdf")]);
  await corePage.fill("#encrypt-owner", "owner-secret");
  await corePage.fill("#encrypt-user", "user-secret");
  const [coreEncryptDownload] = await Promise.all([corePage.waitForEvent("download"), corePage.click("#encrypt-run")]);
  const coreEncryptedPath = path.join(os.tmpdir(), "pdfrs-smoke-core-encrypted.pdf");
  await coreEncryptDownload.saveAs(coreEncryptedPath);

  await corePage.click('#tabs [data-target="panel-decrypt"]');
  await corePage.setInputFiles("#decrypt-input", [coreEncryptedPath]);
  await corePage.fill("#decrypt-password", "user-secret");
  await Promise.all([corePage.waitForEvent("download"), corePage.click("#decrypt-run")]);

  const fullPackageFetchedByCoreOnlyPage = coreRequests.some(isFullPackageRequest);
  await corePage.close();

  const previewPage = await browser.newPage();
  const previewRequests = [];
  previewPage.on("request", (req) => previewRequests.push(req.url()));
  await previewPage.goto(baseUrl, { waitUntil: "networkidle" });
  await previewPage.click('#tabs [data-target="panel-preview"]');
  await previewPage.setInputFiles("#preview-input", [path.join(fixtures, "one_page.pdf")]);
  await previewPage.waitForFunction(() => {
    const text = document.querySelector("#preview-status")?.textContent?.trim() ?? "";
    return text.startsWith("Fatto") || text.startsWith("Errore");
  });
  const fullPackageFetchedByPreviewPage = previewRequests.some(isFullPackageRequest);
  await previewPage.close();

  await browser.close();

  const results = {
    "heartbeat ticks on the main thread": heartbeatIsTicking,
    "heartbeat keeps ticking during a wasm call (worker, not main thread)": heartbeatKeptTickingDuringPreview,
    "preview status succeeds": previewStatus.startsWith("Fatto"),
    "preview renders one card per page": previewCardCount === 2,
    "parallel preview (worker pool) status succeeds": parallelPreviewStatus.startsWith("Fatto"),
    "parallel preview renders one card per page": parallelPreviewCardCount === 10,
    "parallel preview fills every card with an image": parallelPreviewImageCount === 10,
    "parallel preview actually used more than one worker": previewPoolSize > 1,
    "preview progress bar becomes visible while rendering": progressWasShownDuringPreview,
    "preview progress bar hides again once rendering completes": progressHiddenAfterPreview,
    "merge downloads merged.pdf": mergeDownload.suggestedFilename() === "merged.pdf",
    "merge status succeeds": mergeStatus.startsWith("Fatto"),
    "split downloads 2 files": splitDownloads.length === 2,
    "split status succeeds": splitStatus.startsWith("Fatto"),
    "rotate downloads rotated.pdf": rotateDownload.suggestedFilename() === "rotated.pdf",
    "annota renders the page thumbnails": annotaPagesStatus.startsWith("Fatto"),
    "annota loads several images into the palette": annotaAssetCount === 2,
    "annota places an image on the page": annotaBoxCount === 1,
    // Dropped at 65% with a 25%-wide box, so its left edge lands near 52.5%.
    "annota drops an image where it was released": droppedBox !== null && Math.abs(droppedBox - 52.5) < 2,
    "annota replicates a placement onto every page": annotaBadges === 4,
    "annota downloads the annotated PDF": annotaDownload.suggestedFilename() === "four_pages-annotato.pdf",
    "annota status succeeds": annotaStatus.startsWith("Fatto"),
    "rotate status succeeds": rotateStatus.startsWith("Fatto"),
    "compose downloads composed.pdf": composeDownload.suggestedFilename() === "composed.pdf",
    "compose status succeeds": composeStatus.startsWith("Fatto"),
    "encrypt downloads encrypted.pdf": encryptDownload.suggestedFilename() === "encrypted.pdf",
    "encrypt status succeeds": encryptStatus.startsWith("Fatto"),
    "decrypt rejects wrong password": wrongPasswordStatus.startsWith("Errore"),
    "decrypt downloads decrypted.pdf": decryptDownload.suggestedFilename() === "decrypted.pdf",
    "decrypt status succeeds with correct password": decryptStatus.startsWith("Fatto"),
    "core/full split: core-only panels never fetch the full wasm package": !fullPackageFetchedByCoreOnlyPage,
    "core/full split: opening Preview does fetch the full wasm package": fullPackageFetchedByPreviewPage,
    "no console/page errors": consoleErrors.length === 0,
  };

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

console.log(ok ? "SMOKE_OK" : "SMOKE_FAILED");
process.exit(ok ? 0 : 1);
