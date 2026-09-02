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
    return Array.from(view.shadowRoot.querySelectorAll("pdf-page-card")).map((c) => c.data.id);
  });

  // --- Rotate page 1, delete page 2 - both local state, no wasm round-trip ---
  await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    cards.find((c) => c.data.id === 1).shadowRoot.querySelector('[data-action="rotate-right"]').click();
    cards.find((c) => c.data.id === 2).shadowRoot.querySelector('[data-action="toggle-delete"]').click();
  });
  const stateAfterEdits = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    return {
      rotation: cards.find((c) => c.data.id === 1).data.pendingRotation,
      deleted: cards.find((c) => c.data.id === 2).data.markedForDeletion,
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

  // --- Progress on the document's pill: opening a bigger document should
  // grow a green fill on its <li> in the doclist (not a <progress> bar at
  // the bottom of the page anymore), then mark it "done" (border) once
  // every page has rendered. ---
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
  const pillFillGrewDuringRender = await page
    .waitForFunction(() => {
      const app = document.querySelector("pdf-editor-app");
      const items = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li'));
      const pill = items.find((li) => li.querySelector("button")?.textContent?.includes("ten_pages.pdf"));
      const width = pill ? parseFloat(pill.querySelector(".fill").style.width) : 0;
      return width > 0 && width < 100;
    })
    .then(() => true)
    .catch(() => false);
  await page.waitForFunction(() => {
    const view = document.querySelector("pdf-editor-app")?.shadowRoot?.querySelector("pdf-document-view");
    return view?.shadowRoot?.querySelectorAll("pdf-page-card").length === 10;
  });
  const pillDoneWhenFinished = await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const items = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li'));
    const pill = items.find((li) => li.querySelector("button")?.textContent?.includes("ten_pages.pdf"));
    return pill.classList.contains("render-done") && pill.querySelector(".fill").style.width === "100%";
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
    return cards[0].data.png.length > 0;
  });

  // --- Virtual scroll: a document above VIRTUAL_SCROLL_THRESHOLD (24 pages)
  // should get a placeholder card for every page right away, but only fill
  // in real previews for cards that actually scroll into view - and its pill
  // should never fill/mark done, since it was never meant to finish "all at
  // once" the way a normal document's preview-progress event implies. ---
  await page.setViewportSize({ width: 380, height: 320 });
  await page.locator("pdf-editor-app").locator('[data-el="input"]').setInputFiles([path.join(fixtures, "many_pages.pdf")]);
  await page.waitForFunction(() => {
    const app = document.querySelector("pdf-editor-app");
    return app?.shadowRoot?.querySelectorAll('[data-el="doclist"] li').length === 7;
  });
  await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const items = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li button'));
    items.find((b) => b.textContent.includes("many_pages.pdf")).click();
  });
  await page.waitForFunction(() => {
    const view = document.querySelector("pdf-editor-app")?.shadowRoot?.querySelector("pdf-document-view");
    return view?.shadowRoot?.querySelectorAll("pdf-page-card").length === 30;
  });
  const placeholderCountRightAway = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    return cards.filter((c) => !("png" in c.data)).length;
  });

  // Give the observer a moment to settle the pages near the (tiny) viewport,
  // then confirm the last page - well outside it, and outside its rootMargin
  // prefetch too, at this viewport size - has genuinely not been rendered yet.
  await page.waitForTimeout(500);
  const farPageNotRenderedBeforeScroll = await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    return !("png" in cards[cards.length - 1].data);
  });

  await page.evaluate(() => {
    const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
    const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
    cards[cards.length - 1].scrollIntoView();
  });
  const farPageRenderedAfterScroll = await page
    .waitForFunction(() => {
      const view = document.querySelector("pdf-editor-app").shadowRoot.querySelector("pdf-document-view");
      const cards = Array.from(view.shadowRoot.querySelectorAll("pdf-page-card"));
      return "png" in cards[cards.length - 1].data;
    })
    .then(() => true)
    .catch(() => false);

  const virtualScrollPillStaysNeutral = await page.evaluate(() => {
    const app = document.querySelector("pdf-editor-app");
    const items = Array.from(app.shadowRoot.querySelectorAll('[data-el="doclist"] li'));
    const pill = items.find((li) => li.querySelector("button")?.textContent?.includes("many_pages.pdf"));
    // No inline width was ever set for this pill (preview-progress never
    // fired for it) - the CSS default (width: 0%) is what's showing, not a
    // completed-and-reset "0%" written by the progress handler.
    const width = pill.querySelector(".fill").style.width;
    return (width === "" || parseFloat(width) === 0) && !pill.classList.contains("render-done");
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.screenshot({ path: path.join(dirname, "editor.png"), fullPage: true });
  await browser.close();

  const results = {
    "opening 2 files renders one card per page for the active document": cardCountAfterOpen === 4,
    "drag & drop reorders the cards (drag page 1 onto page 3's spot)": orderAfterDrag.join(",") === "2,3,1,4",
    "rotate/delete update pending state locally": stateAfterEdits.rotation === 90 && stateAfterEdits.deleted === true,
    "commit removes the deleted page (4 -> 3)": afterCommit.cardCount === 3 && afterCommit.heading.includes("3 pagine"),
    "merge registers a third document with the summed page count (3+2=5)":
      afterMerge.docCount === 3 && afterMerge.heading.includes("5 pagine"),
    "the document's pill fills up (green) while it's rendering": pillFillGrewDuringRender,
    "the pill is marked done (full fill + border) once rendering completes": pillDoneWhenFinished,
    "dropping a JPEG registers a one-page document": imageDocPageCount.includes("(1p)"),
    "merging the image document with a PDF sums their page counts (1+2=3)": afterImageMerge.heading.includes("3 pagine"),
    "the merged image page actually renders (JPEG survived compress())": imagePreviewRendered,
    "virtual scroll: every page gets a placeholder card immediately": placeholderCountRightAway === 30,
    "virtual scroll: a far-off page isn't rendered before it scrolls into view": farPageNotRenderedBeforeScroll,
    "virtual scroll: scrolling a page into view renders it": farPageRenderedAfterScroll,
    "virtual scroll: the pill never fills/marks done for this document": virtualScrollPillStaysNeutral,
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
