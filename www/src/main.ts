// Every call below goes through a Web Worker (see pdfrs-worker-client.ts /
// pdfrs.worker.ts), not the "pdfrs" wasm package directly - the actual CPU
// work happens off this thread, so the UI never freezes while it runs. The
// heartbeat counter further down is the visible proof of that.
import {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  merge_pdfs,
  page_count,
  render_page_preview,
  rotate_pages,
  split_pdf,
  stamp_image,
} from "./pdfrs-worker-client";
import { bytesToObjectUrl, downloadBytes, fileToUint8Array, setupFileInput } from "./pdf-io";
import { parseLayout, parseRanges, parseRotations } from "./parsers";
import { renderPagesInParallel } from "./preview-worker-pool";
import { hasTransparency, imageToRgba, type DecodedImage } from "./image-io";
// Side-effect import: registers <pdf-editor-app> (and the components it uses
// internally) for the "Editor" tab. See src/webcomponents/index.ts.
import "./webcomponents";

// Above this many pages, Preview spreads rendering across a pool of workers
// (see preview-worker-pool.ts) instead of one page at a time on the single
// shared worker - each pool worker carries its own copy of the wasm module,
// so it's only worth it once there's enough pages to amortize that cost.
const PARALLEL_PREVIEW_THRESHOLD = 6;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Elemento #${id} non trovato`);
  return el as T;
}

// Tab navigation: only one panel visible at a time, switched entirely via
// JS (no URL/route change) - all panels stay on the same page, just
// hidden/shown, so nothing here needs its own route.
{
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#tabs .tab"));
  const panels = tabs.map((tab) => byId<HTMLElement>(tab.dataset.target ?? ""));

  function activate(index: number) {
    tabs.forEach((tab, i) => tab.classList.toggle("tab--active", i === index));
    panels.forEach((panel, i) => {
      panel.hidden = i !== index;
    });
  }

  tabs.forEach((tab, index) => tab.addEventListener("click", () => activate(index)));
  activate(0);
}

// Ticks every animation frame purely to prove the main thread stays
// responsive while a wasm call is in flight on the worker: if this counter
// froze during an operation, the UI would be blocked.
{
  const counter = byId<HTMLElement>("heartbeat-count");
  let ticks = 0;
  const tick = () => {
    ticks += 1;
    counter.textContent = String(ticks);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setStatus(el: HTMLElement, message: string, kind: "ok" | "error" | "" = "") {
  el.textContent = message;
  el.className = `status ${kind ? `status--${kind}` : ""}`.trim();
}

async function runWithStatus(statusEl: HTMLElement, action: () => Promise<void>) {
  setStatus(statusEl, "In corso…");
  try {
    await action();
  } catch (err) {
    setStatus(statusEl, `Errore: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** Wires a multi-file panel (merge/compose): dropzone + input accumulate files, shown as an indexed list. */
function setupMultiFilePanel(prefix: string): { getFiles: () => File[] } {
  const drop = byId<HTMLElement>(`${prefix}-drop`);
  const input = byId<HTMLInputElement>(`${prefix}-input`);
  const list = byId<HTMLUListElement>(`${prefix}-filelist`);
  const clearBtn = byId<HTMLButtonElement>(`${prefix}-clear`);

  let files: File[] = [];

  function render() {
    list.innerHTML = "";
    files.forEach((file, index) => {
      const li = document.createElement("li");
      li.textContent = `[${index}] ${file.name}`;
      list.appendChild(li);
    });
  }

  setupFileInput(drop, input, (dropped) => {
    files = [...files, ...dropped];
    render();
  });

  clearBtn.addEventListener("click", () => {
    files = [];
    render();
  });

  return { getFiles: () => files };
}

/** Wires a single-file panel: dropzone + input keep only the latest file. */
function setupSingleFilePanel(prefix: string): { getFile: () => File | null } {
  const drop = byId<HTMLElement>(`${prefix}-drop`);
  const input = byId<HTMLInputElement>(`${prefix}-input`);
  const filenameEl = byId<HTMLElement>(`${prefix}-filename`);

  let file: File | null = null;

  setupFileInput(drop, input, (dropped) => {
    file = dropped[0] ?? null;
    filenameEl.textContent = file ? file.name : "Nessun file selezionato";
  });

  return { getFile: () => file };
}

// --- Preview: drop a PDF, render one thumbnail card per page ---
{
  const status = byId<HTMLElement>("preview-status");
  const progress = byId<HTMLProgressElement>("preview-progress");
  const grid = byId<HTMLElement>("preview-grid");
  const drop = byId<HTMLElement>("preview-drop");
  const input = byId<HTMLInputElement>("preview-input");

  setupFileInput(drop, input, (files) => {
    const file = files[0];
    if (!file) return;

    void runWithStatus(status, async () => {
      grid.innerHTML = "";

      const bytes = await fileToUint8Array(file);
      const count = await page_count(bytes);

      // One placeholder card per page, created up front: when rendering runs
      // on a worker pool, pages complete out of order, so each card needs a
      // fixed slot to be filled into rather than being appended as it arrives.
      const cardImages = new Map<number, HTMLImageElement>();
      for (let page = 1; page <= count; page++) {
        const card = document.createElement("div");
        card.className = "preview-card";

        const img = document.createElement("img");
        img.alt = `Pagina ${page}`;

        const label = document.createElement("span");
        label.textContent = `Pagina ${page}`;

        card.append(img, label);
        grid.appendChild(card);
        cardImages.set(page, img);
      }

      let done = 0;
      progress.value = 0;
      progress.max = count;
      progress.hidden = false;

      const fillCard = (page: number, png: Uint8Array) => {
        const img = cardImages.get(page);
        if (img) img.src = bytesToObjectUrl(png, "image/png");
        done += 1;
        progress.value = done;
        setStatus(status, `Rendering anteprime… (${done}/${count})`);
      };

      try {
        if (count > PARALLEL_PREVIEW_THRESHOLD) {
          const allPages = Array.from({ length: count }, (_, index) => index + 1);
          await renderPagesInParallel(bytes, allPages, 0.4, fillCard);
        } else {
          for (let page = 1; page <= count; page++) {
            fillCard(page, await render_page_preview(bytes, page, 0.4));
          }
        }
      } finally {
        progress.hidden = true;
      }

      setStatus(status, `Fatto: ${count} pagine renderizzate`, "ok");
    });
  });
}

// --- Merge ---
{
  const status = byId<HTMLElement>("merge-status");
  const { getFiles } = setupMultiFilePanel("merge");

  byId<HTMLButtonElement>("merge-run").addEventListener("click", () =>
    runWithStatus(status, async () => {
      const files = getFiles();
      if (files.length === 0) throw new Error("aggiungi almeno un PDF");

      const buffers = await Promise.all(files.map(fileToUint8Array));
      const merged = await merge_pdfs(buffers);
      downloadBytes(merged, "merged.pdf");
      setStatus(status, `Fatto: ${files.length} file uniti in merged.pdf`, "ok");
    }),
  );
}

// --- Split ---
{
  const status = byId<HTMLElement>("split-status");
  const { getFile } = setupSingleFilePanel("split");
  const rangesInput = byId<HTMLInputElement>("split-ranges");

  byId<HTMLButtonElement>("split-run").addEventListener("click", () =>
    runWithStatus(status, async () => {
      const file = getFile();
      if (!file) throw new Error("seleziona un PDF");

      const ranges = parseRanges(rangesInput.value);
      if (ranges.length === 0) throw new Error("inserisci almeno un range, es. 1-2");

      const bytes = await fileToUint8Array(file);
      const parts = (await split_pdf(bytes, ranges)) as Uint8Array[];
      parts.forEach((part, index) => downloadBytes(part, `split-${index + 1}.pdf`));
      setStatus(status, `Fatto: ${parts.length} file generati`, "ok");
    }),
  );
}

// --- Rotate ---
{
  const status = byId<HTMLElement>("rotate-status");
  const { getFile } = setupSingleFilePanel("rotate");
  const rotationsInput = byId<HTMLInputElement>("rotate-rotations");

  byId<HTMLButtonElement>("rotate-run").addEventListener("click", () =>
    runWithStatus(status, async () => {
      const file = getFile();
      if (!file) throw new Error("seleziona un PDF");

      const rotations = parseRotations(rotationsInput.value);
      if (rotations.length === 0) throw new Error("inserisci almeno una rotazione, es. 1:90");

      const bytes = await fileToUint8Array(file);
      const rotated = await rotate_pages(bytes, rotations);
      downloadBytes(rotated, "rotated.pdf");
      setStatus(status, "Fatto: rotated.pdf", "ok");
    }),
  );
}

// --- Compose ---
{
  const status = byId<HTMLElement>("compose-status");
  const { getFiles } = setupMultiFilePanel("compose");
  const layoutInput = byId<HTMLInputElement>("compose-layout");

  byId<HTMLButtonElement>("compose-run").addEventListener("click", () =>
    runWithStatus(status, async () => {
      const files = getFiles();
      if (files.length === 0) throw new Error("aggiungi almeno un PDF sorgente");

      const layout = parseLayout(layoutInput.value);
      if (layout.length === 0) throw new Error("inserisci almeno una voce di layout, es. 0:1");

      const buffers = await Promise.all(files.map(fileToUint8Array));
      const composed = await compose_pdf(buffers, layout);
      downloadBytes(composed, "composed.pdf");
      setStatus(status, "Fatto: composed.pdf", "ok");
    }),
  );
}

// --- Encrypt ---
{
  const status = byId<HTMLElement>("encrypt-status");
  const { getFile } = setupSingleFilePanel("encrypt");
  const ownerInput = byId<HTMLInputElement>("encrypt-owner");
  const userInput = byId<HTMLInputElement>("encrypt-user");

  byId<HTMLButtonElement>("encrypt-run").addEventListener("click", () =>
    runWithStatus(status, async () => {
      const file = getFile();
      if (!file) throw new Error("seleziona un PDF");

      const bytes = await fileToUint8Array(file);
      const encrypted = await encrypt_pdf(bytes, ownerInput.value, userInput.value);
      downloadBytes(encrypted, "encrypted.pdf");
      setStatus(status, "Fatto: encrypted.pdf", "ok");
    }),
  );
}

// --- Decrypt ---
{
  const status = byId<HTMLElement>("decrypt-status");
  const { getFile } = setupSingleFilePanel("decrypt");
  const passwordInput = byId<HTMLInputElement>("decrypt-password");

  byId<HTMLButtonElement>("decrypt-run").addEventListener("click", () =>
    runWithStatus(status, async () => {
      const file = getFile();
      if (!file) throw new Error("seleziona un PDF");

      const bytes = await fileToUint8Array(file);
      const decrypted = await decrypt_pdf(bytes, passwordInput.value);
      downloadBytes(decrypted, "decrypted.pdf");
      setStatus(status, "Fatto: decrypted.pdf", "ok");
    }),
  );
}

// --- Firma: stamp a PNG signature onto one page of a PDF ---
//
// The PNG is decoded here, in the browser, and only raw RGBA pixels are sent
// to wasm - which is what keeps `stamp_image` out of the image-decoding
// ("full") build. The position/size the user drags out is stored in
// percentages of the displayed page, the same units the wasm side takes, so
// nothing depends on the scale the preview happens to be rendered at.
{
  const status = byId<HTMLElement>("firma-status");
  const pagesEl = byId<HTMLElement>("firma-pages");
  const stage = byId<HTMLElement>("firma-stage");
  const pageImg = byId<HTMLImageElement>("firma-page-img");
  const box = byId<HTMLElement>("firma-box");
  const boxImg = byId<HTMLImageElement>("firma-box-img");
  const handle = byId<HTMLElement>("firma-handle");

  let pdfBytes: Uint8Array | null = null;
  let pdfName = "documento.pdf";
  let selectedPage: number | null = null;
  let signature: DecodedImage | null = null;
  // Fractions of the displayed page: x/y are the box's top-left corner, width
  // its width. The height follows from the image's aspect ratio, so the
  // signature can't be stretched.
  let placement = { x: 0.1, y: 0.7, width: 0.3 };

  const aspectRatio = () => (signature ? signature.height / signature.width : 1);

  function drawBox(): void {
    if (!signature || selectedPage === null) {
      box.hidden = true;
      return;
    }
    const stageWidth = pageImg.clientWidth;
    const stageHeight = pageImg.clientHeight;
    if (stageWidth === 0 || stageHeight === 0) return;

    // The box keeps the image's proportions in *pixels*, so the percentage
    // height differs from the percentage width whenever the page isn't square.
    const widthPx = placement.width * stageWidth;
    const heightPx = widthPx * aspectRatio();
    box.hidden = false;
    box.style.left = `${placement.x * 100}%`;
    box.style.top = `${placement.y * 100}%`;
    box.style.width = `${placement.width * 100}%`;
    box.style.height = `${(heightPx / stageHeight) * 100}%`;
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  // One pointer gesture at a time: dragging the box, or resizing from the corner.
  function startGesture(event: PointerEvent, mode: "move" | "resize"): void {
    if (!signature || selectedPage === null) return;
    event.preventDefault();
    event.stopPropagation();

    const stageWidth = pageImg.clientWidth;
    const stageHeight = pageImg.clientHeight;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...placement };
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const deltaX = (move.clientX - startX) / stageWidth;
      const deltaY = (move.clientY - startY) / stageHeight;

      if (mode === "move") {
        const heightFraction = (start.width * stageWidth * aspectRatio()) / stageHeight;
        placement = {
          ...start,
          x: clamp(start.x + deltaX, 0, 1 - start.width),
          y: clamp(start.y + deltaY, 0, Math.max(0, 1 - heightFraction)),
        };
      } else {
        const width = clamp(start.width + deltaX, 0.02, 1 - start.x);
        // Don't let the corner drag push the box off the bottom edge.
        const heightFraction = (width * stageWidth * aspectRatio()) / stageHeight;
        placement = { ...start, width: start.y + heightFraction > 1 ? start.width : width };
      }
      drawBox();
    };

    const onUp = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  box.addEventListener("pointerdown", (event) => startGesture(event, "move"));
  handle.addEventListener("pointerdown", (event) => startGesture(event, "resize"));

  async function selectPage(page: number): Promise<void> {
    if (!pdfBytes) return;
    selectedPage = page;
    for (const thumb of Array.from(pagesEl.querySelectorAll(".firma-thumb"))) {
      thumb.classList.toggle("selected", Number((thumb as HTMLElement).dataset.page) === page);
    }
    // Rendered bigger than the thumbnails: this is the one you aim with.
    // CSS caps how tall it displays; the box's percentages are read off the
    // displayed size, so the two stay consistent.
    const png = await render_page_preview(pdfBytes, page, 0.7);
    pageImg.src = bytesToObjectUrl(png, "image/png");
    stage.hidden = false;
    await pageImg.decode().catch(() => undefined);
    drawBox();
  }

  setupFileInput(byId<HTMLElement>("firma-drop"), byId<HTMLInputElement>("firma-input"), (files) => {
    const file = files[0];
    if (!file) return;
    pdfName = file.name;
    byId<HTMLElement>("firma-filename").textContent = file.name;

    void runWithStatus(status, async () => {
      pagesEl.innerHTML = "";
      stage.hidden = true;
      selectedPage = null;

      pdfBytes = await fileToUint8Array(file);
      const count = await page_count(pdfBytes);

      const thumbs = new Map<number, HTMLImageElement>();
      for (let page = 1; page <= count; page++) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "firma-thumb";
        button.dataset.page = String(page);
        const img = document.createElement("img");
        const label = document.createElement("span");
        label.textContent = `Pagina ${page}`;
        button.append(img, label);
        button.addEventListener("click", () => void runWithStatus(status, () => selectPage(page)));
        pagesEl.appendChild(button);
        thumbs.set(page, img);
      }

      const fill = (page: number, png: Uint8Array) => {
        const img = thumbs.get(page);
        if (img) img.src = bytesToObjectUrl(png, "image/png");
      };

      const bytes = pdfBytes;
      if (count > PARALLEL_PREVIEW_THRESHOLD) {
        await renderPagesInParallel(bytes, Array.from({ length: count }, (_, index) => index + 1), 0.25, fill);
      } else {
        for (let page = 1; page <= count; page++) fill(page, await render_page_preview(bytes, page, 0.25));
      }

      await selectPage(1);
      setStatus(status, `Fatto: ${count} pagine, scegli quella da firmare`, "ok");
    });
  });

  setupFileInput(
    byId<HTMLElement>("firma-image-drop"),
    byId<HTMLInputElement>("firma-image-input"),
    (files) => {
      const file = files[0];
      if (!file) return;
      byId<HTMLElement>("firma-image-filename").textContent = file.name;

      void runWithStatus(status, async () => {
        signature = await imageToRgba(file);
        boxImg.src = URL.createObjectURL(file);
        drawBox();
        const warning = hasTransparency(signature)
          ? ""
          : " (attenzione: il PNG non ha trasparenza, coprirà il testo sotto)";
        setStatus(status, `Fatto: firma caricata, trascinala sulla pagina${warning}`, "ok");
      });
    },
    (file) => file.type === "image/png",
  );

  byId<HTMLButtonElement>("firma-run").addEventListener("click", () =>
    void runWithStatus(status, async () => {
      if (!pdfBytes) throw new Error("seleziona un PDF");
      if (selectedPage === null) throw new Error("scegli la pagina da firmare");
      if (!signature) throw new Error("carica il PNG della firma");

      // Every top-level Uint8Array argument is *transferred* to the worker
      // (see collectTransferables), which neuters ours - so hand over copies
      // of both buffers and stay able to sign a second page without
      // re-opening the file.
      const signed = await stamp_image(
        new Uint8Array(pdfBytes),
        selectedPage,
        new Uint8Array(signature.pixels),
        signature.width,
        signature.height,
        placement,
      );
      downloadBytes(signed, pdfName.replace(/\.pdf$/i, "") + "-firmato.pdf");
      setStatus(status, `Fatto: firma applicata alla pagina ${selectedPage}`, "ok");
    }),
  );
}
