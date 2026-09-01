// End-to-end smoke test for the pdfrs test frontend: drives the actual page
// with Playwright (real DOM events, real wasm module) to exercise every panel
// through the same path a human would use it - the wasm-bindgen boundary that
// the Rust unit tests in ../../tests can't cover.
//
// Run with `pnpm test:e2e` (starts its own Vite dev server on port 5183).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
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

  async function waitForSettledStatus(selector) {
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent?.trim() !== "In corso…",
      selector,
    );
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

  // --- Preview: drop two_pages.pdf, expect one thumbnail card per page ---
  const heartbeatBeforePreview = await readHeartbeat();
  await page.setInputFiles("#preview-input", [path.join(fixtures, "two_pages.pdf")]);
  const previewStatus = await waitForSettledStatus("#preview-status");
  const previewCardCount = await page.locator("#preview-grid .preview-card").count();
  const heartbeatKeptTickingDuringPreview = (await readHeartbeat()) > heartbeatBeforePreview;

  // --- Preview with a worker pool: ten_pages.pdf has more pages than
  // PARALLEL_PREVIEW_THRESHOLD (6), so this run should fan out across
  // several workers instead of the single shared one used above. ---
  await page.setInputFiles("#preview-input", [path.join(fixtures, "ten_pages.pdf")]);
  const parallelPreviewStatus = await waitForSettledStatus("#preview-status");
  const parallelPreviewCardCount = await page.locator("#preview-grid .preview-card").count();
  const parallelPreviewImageCount = await page
    .locator("#preview-grid .preview-card img")
    .evaluateAll((imgs) => imgs.filter((img) => img.getAttribute("src")).length);
  const previewPoolSize = await page.evaluate(() => window.__pdfrsLastPreviewPoolSize);

  // --- Merge: two_pages.pdf + one_page.pdf -> expect a download ---
  await page.setInputFiles("#merge-input", [
    path.join(fixtures, "two_pages.pdf"),
    path.join(fixtures, "one_page.pdf"),
  ]);
  const [mergeDownload] = await Promise.all([page.waitForEvent("download"), page.click("#merge-run")]);
  const mergeStatus = await waitForSettledStatus("#merge-status");

  // --- Split four_pages.pdf into 1-2 and 3-4 -> expect two downloads ---
  await page.setInputFiles("#split-input", [path.join(fixtures, "four_pages.pdf")]);
  await page.fill("#split-ranges", "1-2,3-4");
  const splitDownloads = [];
  page.on("download", (d) => {
    if (d.suggestedFilename().startsWith("split-")) splitDownloads.push(d);
  });
  await page.click("#split-run");
  const splitStatus = await waitForSettledStatus("#split-status");

  // --- Rotate one_page.pdf ---
  await page.setInputFiles("#rotate-input", [path.join(fixtures, "one_page.pdf")]);
  await page.fill("#rotate-rotations", "1:90");
  const [rotateDownload] = await Promise.all([page.waitForEvent("download"), page.click("#rotate-run")]);
  const rotateStatus = await waitForSettledStatus("#rotate-status");

  // --- Compose: interleave pages from two_pages.pdf and one_page.pdf ---
  await page.setInputFiles("#compose-input", [
    path.join(fixtures, "two_pages.pdf"),
    path.join(fixtures, "one_page.pdf"),
  ]);
  await page.fill("#compose-layout", "1:1,0:2,0:1");
  const [composeDownload] = await Promise.all([page.waitForEvent("download"), page.click("#compose-run")]);
  const composeStatus = await waitForSettledStatus("#compose-status");

  // --- Encrypt one_page.pdf, then feed the result back into Decrypt ---
  await page.setInputFiles("#encrypt-input", [path.join(fixtures, "one_page.pdf")]);
  await page.fill("#encrypt-owner", "owner-secret");
  await page.fill("#encrypt-user", "user-secret");
  const [encryptDownload] = await Promise.all([page.waitForEvent("download"), page.click("#encrypt-run")]);
  const encryptStatus = await waitForSettledStatus("#encrypt-status");

  const encryptedPath = path.join(os.tmpdir(), "pdfrs-smoke-encrypted.pdf");
  await encryptDownload.saveAs(encryptedPath);

  // Wrong password -> expect an error surfaced in the status area, no crash.
  await page.setInputFiles("#decrypt-input", [encryptedPath]);
  await page.fill("#decrypt-password", "wrong-password");
  await page.click("#decrypt-run");
  const wrongPasswordStatus = await waitForSettledStatus("#decrypt-status");

  // Correct password -> expect success and a download.
  await page.fill("#decrypt-password", "user-secret");
  const [decryptDownload] = await Promise.all([page.waitForEvent("download"), page.click("#decrypt-run")]);
  const decryptStatus = await waitForSettledStatus("#decrypt-status");

  await page.screenshot({ path: path.join(dirname, "smoke.png"), fullPage: true });
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
    "merge downloads merged.pdf": mergeDownload.suggestedFilename() === "merged.pdf",
    "merge status succeeds": mergeStatus.startsWith("Fatto"),
    "split downloads 2 files": splitDownloads.length === 2,
    "split status succeeds": splitStatus.startsWith("Fatto"),
    "rotate downloads rotated.pdf": rotateDownload.suggestedFilename() === "rotated.pdf",
    "rotate status succeeds": rotateStatus.startsWith("Fatto"),
    "compose downloads composed.pdf": composeDownload.suggestedFilename() === "composed.pdf",
    "compose status succeeds": composeStatus.startsWith("Fatto"),
    "encrypt downloads encrypted.pdf": encryptDownload.suggestedFilename() === "encrypted.pdf",
    "encrypt status succeeds": encryptStatus.startsWith("Fatto"),
    "decrypt rejects wrong password": wrongPasswordStatus.startsWith("Errore"),
    "decrypt downloads decrypted.pdf": decryptDownload.suggestedFilename() === "decrypted.pdf",
    "decrypt status succeeds with correct password": decryptStatus.startsWith("Fatto"),
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
