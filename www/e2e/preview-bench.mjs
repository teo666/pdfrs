// How long thumbnails take on a real PDF, through the same worker pool the
// app uses (renderPagesInParallel). A measurement, not a check:
//
//   node e2e/preview-bench.mjs path/to/file.pdf [pages per round] [workers]
//
// Starts its own Vite dev server on port 5191. Three rounds of the next
// `pages` pages each (default 24) at the app's thumbnail scale: the first
// pays for sending the file to the workers and reading it there, the next two
// show the cost of a page once the workers hold the document. With one
// worker the time per page is what each page costs a worker; with the
// default (as many as the app would use, up to 8) it's what the user waits.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = process.argv[2] && path.resolve(process.argv[2]);
if (!file) {
  console.error("usage: node e2e/preview-bench.mjs path/to/file.pdf [pages per round] [workers]");
  process.exit(1);
}
const perRound = Number(process.argv[3] ?? 24);
const workers = process.argv[4] ? Number(process.argv[4]) : undefined;

const wwwRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 5191;
const baseUrl = `http://localhost:${port}/model-test.html`;
const vite = spawn(path.join(wwwRoot, "node_modules", ".bin", "vite"), ["--port", String(port), "--strictPort"], {
  cwd: wwwRoot,
  stdio: "ignore",
});

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetch(url).then((res) => res.ok, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for dev server at ${url}`);
}

try {
  await waitForServer(baseUrl, 20_000);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (msg) => msg.type() === "error" && console.error("console:", msg.text()));
  page.on("pageerror", (err) => console.error("pageerror:", err.message));
  const pdf = await readFile(file);
  await page.route("**/bench.pdf", (route) => route.fulfill({ body: pdf, contentType: "application/pdf" }));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__pdfModel));

  const result = await page.evaluate(async ({ perRound, workers }) => {
    const { PdfDocument, renderPagesInParallel } = window.__pdfModel;
    const bytes = new Uint8Array(await (await fetch("/bench.pdf")).arrayBuffer());
    const count = (await PdfDocument.open(bytes.slice())).getPageCount();

    // Workers started and the full build compiled, on a throwaway document,
    // so that the rounds below measure pages and nothing else.
    const warm = bytes.slice();
    await renderPagesInParallel(warm, [1], 0.25, () => {}, workers);

    const rounds = [];
    let next = 1;
    for (let round = 0; round < 3 && next <= count; round++) {
      const pages = [];
      for (let i = 0; i < perRound && next <= count; i++) pages.push(next++);
      const start = performance.now();
      await renderPagesInParallel(bytes, pages, 0.4, () => {}, workers);
      rounds.push({ pages: pages.length, ms: Math.round(performance.now() - start) });
    }
    return { count, workers: window.__pdfrsLastPreviewPoolSize, rounds };
  }, { perRound, workers });

  const mb = (pdf.length / 1e6).toFixed(1);
  console.log(`${path.basename(file)}: ${mb} MB, ${result.count} pages, ${result.workers} workers`);
  for (const [index, { pages, ms }] of result.rounds.entries()) {
    console.log(`  round ${index + 1}: ${pages} pages in ${ms} ms (${(ms / pages).toFixed(1)} ms/page)`);
  }
  await browser.close();
} finally {
  vite.kill();
}
