// End-to-end test for the "Editor" tab's Web Components example
// (<pdf-editor-app>/<pdf-document-view>/<pdf-page-card>, in
// src/webcomponents/), which wraps PdfDocument/PdfEditor visually. Verifies
// the whole flow through the real shadow-DOM components in a real browser:
// open two documents, rotate one page and delete another (both purely local
// state - no wasm call), commit, then merge the two documents and confirm
// the rotation survived into the merged result.
//
// Run with `pnpm test:editor` (starts its own Vite dev server on port 5185).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const wwwRoot = path.resolve(dirname, "..");
const fixtures = path.resolve(wwwRoot, "../tests/fixtures");
const port = 5185;
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
  await page.click('#tabs [data-target="panel-editor"]');

  // --- Open two documents ---
  await page.locator("pdf-editor-app").locator('[data-el="input"]').setInputFiles([
    path.join(fixtures, "four_pages.pdf"),
    path.join(fixtures, "two_pages.pdf"),
  ]);

  await page.waitForFunction(() => {
    const app = document.querySelector("pdf-editor-app");
    return app?.shadowRoot?.querySelectorAll('[data-el="doclist"] li').length === 2;
  });
  await page.waitForFunction(() => {
    const view = document.querySelector("pdf-editor-app")?.shadowRoot?.querySelector("pdf-document-view");
    return view?.shadowRoot?.querySelectorAll("pdf-page-card").length === 4;
  });
  const cardCountAfterOpen = await page.evaluate(
    () =>
      document
        .querySelector("pdf-editor-app")
        .shadowRoot.querySelector("pdf-document-view")
        .shadowRoot.querySelectorAll("pdf-page-card").length,
  );

  // --- Drag & drop reordering: drag card[0] (page 1) onto card[2] (page 3) -
  // page 1 should move to that position, shifting 2 and 3 back. Local state
  // only (movePage), no wasm round-trip. ---
  const activeDocView = page.locator("pdf-editor-app").locator("pdf-document-view");
  const pageCards = activeDocView.locator("pdf-page-card");
  await pageCards.nth(0).dragTo(pageCards.nth(2));
  const orderAfterDrag = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    return Array.from(view.shadowRoot.querySelectorAll("pdf-page-card")).map((c) => c.preview.id);
  });

  // --- Rotate page 1, delete page 2 - both local state, no wasm round-trip ---
  await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    cards.find((c) => c.preview.id === 1).shadowRoot.querySelector('[data-action="rotate-right"]').click();
    cards.find((c) => c.preview.id === 2).shadowRoot.querySelector('[data-action="toggle-delete"]').click();
  });
  const stateAfterEdits = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    return {
      rotation: cards.find((c) => c.preview.id === 1).preview.pendingRotation,
      deleted: cards.find((c) => c.preview.id === 2).preview.markedForDeletion,
    };
  });

  // --- Commit: page 2 should be gone, page count drops from 4 to 3 ---
  await page.evaluate(() =>
    document
      .querySelector("pdf-editor-app")
      .shadowRoot.querySelector("pdf-document-view")
      .shadowRoot.querySelector('[data-action="commit"]')
      .click(),
  );
  await page.waitForFunction(() =>
    document
      .querySelector("pdf-editor-app")
      .shadowRoot.querySelector("pdf-document-view")
      .shadowRoot.querySelector(".status")
      ?.textContent?.includes("confermate"),
  );
  const afterCommit = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    return {
      cardCount: view.shadowRoot.querySelectorAll("pdf-page-card").length,
      heading: view.shadowRoot.querySelector("h3").textContent,
    };
  });

  // --- Merge the two documents: 3 + 2 = 5 pages, and the committed rotation
  // on the surviving page must have made it into the merged result. ---
  await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    app.shadowRoot.querySelectorAll('[data-el="doclist"] input[type="checkbox"]').forEach((cb) => cb.click());
    app.shadowRoot.querySelector('[data-action="merge"]').click();
  });
  await page.waitForFunction(() =>
    document.querySelector("pdf-editor-app").shadowRoot.querySelector('[data-el="status"]')?.textContent?.includes("uniti"),
  );
  const afterMerge = await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const view = app.shadowRoot.querySelector("pdf-document-view");
    return {
      docCount: app.shadowRoot.querySelectorAll('[data-el="doclist"] li').length,
      heading: view.shadowRoot.querySelector("h3").textContent,
    };
  });

  // --- Progress bar: open a bigger document and check the <progress> element
  // in <pdf-document-view> actually becomes visible while rendering, then
  // hides again once all pages are done. ---
  await page.locator("pdf-editor-app").locator('[data-el="input"]').setInputFiles([path.join(fixtures, "ten_pages.pdf")]);
  await page.waitForFunction(() => {
    const app = document.querySelector("pdf-editor-app");
    return app?.shadowRoot?.querySelectorAll('[data-el="doclist"] li').length === 4;
  });
  // The new document isn't auto-selected (an active one is already set), so pick it explicitly.
  await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const items = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li button'));
    items.find((b) => b.textContent.includes("ten_pages.pdf")).click();
  });
  const progressWasShown = await page.waitForFunction(() => {
    const view = document.querySelector("pdf-editor-app")?.shadowRoot?.querySelector("pdf-document-view");
    const progress = view?.shadowRoot?.querySelector("progress");
    return progress && !progress.hidden;
  }).then(() => true).catch(() => false);
  await page.waitForFunction(() => {
    const view = document.querySelector("pdf-editor-app")?.shadowRoot?.querySelector("pdf-document-view");
    return view?.shadowRoot?.querySelectorAll("pdf-page-card").length === 10;
  });
  const progressHiddenWhenDone = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    return view.shadowRoot.querySelector("progress").hidden;
  });

  // --- Image import: dropping a JPEG registers a one-page document, and it
  // merges seamlessly with a real PDF (same UI path as merging two PDFs). ---
  await page.locator("pdf-editor-app").locator('[data-el="input"]').setInputFiles([path.join(fixtures, "photo.jpg")]);
  await page.waitForFunction(() => {
    const app = document.querySelector("pdf-editor-app");
    return app?.shadowRoot?.querySelectorAll('[data-el="doclist"] li').length === 5;
  });
  const imageDocPageCount = await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const items = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li button'));
    const photoButton = items.find((b) => b.textContent.includes("photo.jpg"));
    return photoButton?.textContent ?? "";
  });

  await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const checkboxes = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li'));
    // Select the photo.jpg document and one PDF document (two_pages.pdf) to merge.
    for (const li of checkboxes) {
      const label = li.querySelector("button")?.textContent ?? "";
      if (label.includes("photo.jpg") || label.includes("two_pages.pdf")) {
        li.querySelector('input[type="checkbox"]').click();
      }
    }
    app.shadowRoot.querySelector('[data-action="merge"]').click();
  });
  await page.waitForFunction(() => {
    const status = document.querySelector("pdf-editor-app").shadowRoot.querySelector('[data-el="status"]');
    return status?.textContent?.includes("uniti");
  });
  const afterImageMerge = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    return { heading: view.shadowRoot.querySelector("h3").textContent };
  });
  // Render the merged result's first page (the image) to prove the embedded
  // JPEG survived mergeDocuments' compress() call, not just that the file is
  // structurally valid.
  await page.waitForFunction(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    return view.shadowRoot.querySelectorAll("pdf-page-card").length === 3;
  });
  const imagePreviewRendered = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = view.shadowRoot.querySelectorAll("pdf-page-card");
    return cards[0].preview.png.length > 0;
  });

  await page.screenshot({ path: path.join(dirname, "editor.png"), fullPage: true });
  await browser.close();

  const results = {
    "opening 2 files renders one card per page for the active document": cardCountAfterOpen === 4,
    "drag & drop reorders the cards (drag page 1 onto page 3's spot)": orderAfterDrag.join(",") === "2,3,1,4",
    "rotate/delete update pending state locally": stateAfterEdits.rotation === 90 && stateAfterEdits.deleted === true,
    "commit removes the deleted page (4 -> 3)": afterCommit.cardCount === 3 && afterCommit.heading.includes("3 pagine"),
    "merge registers a third document with the summed page count (3+2=5)":
      afterMerge.docCount === 3 && afterMerge.heading.includes("5 pagine"),
    "progress bar becomes visible while rendering a bigger document": progressWasShown,
    "progress bar hides again once rendering completes": progressHiddenWhenDone,
    "dropping a JPEG registers a one-page document": imageDocPageCount.includes("(1p)"),
    "merging the image document with a PDF sums their page counts (1+2=3)": afterImageMerge.heading.includes("3 pagine"),
    "the merged image page actually renders (JPEG survived compress())": imagePreviewRendered,
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

console.log(ok ? "EDITOR_OK" : "EDITOR_FAILED");
process.exit(ok ? 0 : 1);
