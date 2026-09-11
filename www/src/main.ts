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
  annotate_pdf,
  rotate_pages,
  split_pdf,
  type Annotation,
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

// --- Annota: place one or more images onto the pages of a PDF ---
//
// Two levels, and the split is what makes "the same signature on every page"
// cheap: an *asset* is an image loaded once, a *placement* is one appearance
// of it on one page. Ten placements of one asset become a single XObject in
// the output PDF, not ten copies.
//
// Images are decoded here in the browser (canvas) and only raw RGBA reaches
// wasm, which is what keeps `annotate_pdf` in the "core" build.
{
  const status = byId<HTMLElement>("annota-status");
  const pagesEl = byId<HTMLElement>("annota-pages");
  const paletteEl = byId<HTMLElement>("annota-palette");
  const stage = byId<HTMLElement>("annota-stage");
  const pageImg = byId<HTMLImageElement>("annota-page-img");
  const hint = byId<HTMLElement>("annota-hint");
  const allPagesButton = byId<HTMLButtonElement>("annota-all-pages");
  const deleteButton = byId<HTMLButtonElement>("annota-delete");

  interface Asset {
    id: number;
    name: string;
    objectUrl: string;
    image: DecodedImage;
  }

  /** One appearance of an asset on one page. Coordinates are fractions of the page as displayed. */
  interface Placement {
    id: number;
    assetId: number;
    page: number;
    x: number;
    y: number;
    width: number;
  }

  let pdfBytes: Uint8Array | null = null;
  let pdfName = "documento.pdf";
  let pageCount = 0;
  let currentPage: number | null = null;
  const assets: Asset[] = [];
  let placements: Placement[] = [];
  let selectedId: number | null = null;
  let nextId = 1;
  // Which palette image is being dragged. Kept here rather than read back out
  // of `dataTransfer` for the same reason the editor keeps `activeDragId` in a
  // module variable: the browser fills the drag payload with its own
  // representation of the dragged image, and custom data doesn't survive it.
  // Only one drag can be in flight at a time, so one variable is enough.
  let draggingAssetId: number | null = null;

  const assetById = (id: number) => assets.find((asset) => asset.id === id);
  const aspectRatio = (assetId: number) => {
    const asset = assetById(assetId);
    return asset ? asset.image.height / asset.image.width : 1;
  };

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  function syncToolbar(): void {
    const selected = placements.find((placement) => placement.id === selectedId);
    allPagesButton.disabled = !selected || pageCount < 2;
    deleteButton.disabled = !selected;
    hint.textContent = selected
      ? "Trascina per spostare, usa l'angolo per ridimensionare. Canc per eliminare."
      : assets.length === 0
        ? "Carica una o più immagini, poi trascinale sulla pagina."
        : "Trascina un'immagine dalla palette sulla pagina, o cliccala per metterla al centro.";
  }

  /** Page thumbnails carry a badge with how many annotations they hold. */
  function syncPageBadges(): void {
    for (const thumb of Array.from(pagesEl.querySelectorAll<HTMLElement>(".annota-thumb"))) {
      const page = Number(thumb.dataset.page);
      const count = placements.filter((placement) => placement.page === page).length;
      const badge = thumb.querySelector(".count") as HTMLElement;
      badge.textContent = count > 0 ? String(count) : "";
      badge.hidden = count === 0;
    }
  }

  /** Rebuilds the boxes for the current page. Cheap enough to redo wholesale on every change. */
  function renderPlacements(): void {
    for (const box of Array.from(stage.querySelectorAll(".annota-box"))) box.remove();
    if (currentPage === null) return;

    const stageWidth = pageImg.clientWidth;
    const stageHeight = pageImg.clientHeight;
    if (stageWidth === 0 || stageHeight === 0) return;

    for (const placement of placements.filter((item) => item.page === currentPage)) {
      const asset = assetById(placement.assetId);
      if (!asset) continue;

      const box = document.createElement("div");
      box.className = "annota-box";
      box.dataset.id = String(placement.id);
      if (placement.id === selectedId) box.classList.add("selected");
      // Keeps the browser's native drag (used by the palette) from starting here.
      box.draggable = false;

      const widthPx = placement.width * stageWidth;
      box.style.left = `${placement.x * 100}%`;
      box.style.top = `${placement.y * 100}%`;
      box.style.width = `${placement.width * 100}%`;
      box.style.height = `${((widthPx * aspectRatio(placement.assetId)) / stageHeight) * 100}%`;

      const img = document.createElement("img");
      img.src = asset.objectUrl;
      img.draggable = false;
      const handle = document.createElement("div");
      handle.className = "annota-handle";
      box.append(img, handle);

      box.addEventListener("pointerdown", (event) => startGesture(event, placement.id, "move"));
      handle.addEventListener("pointerdown", (event) => startGesture(event, placement.id, "resize"));

      stage.appendChild(box);
    }
  }

  function select(id: number | null): void {
    selectedId = id;
    renderPlacements();
    syncToolbar();
  }

  /** One pointer gesture at a time: moving a box, or resizing it from its corner. */
  function startGesture(event: PointerEvent, placementId: number, mode: "move" | "resize"): void {
    event.preventDefault();
    event.stopPropagation();
    select(placementId);

    const placement = placements.find((item) => item.id === placementId);
    if (!placement) return;

    const stageWidth = pageImg.clientWidth;
    const stageHeight = pageImg.clientHeight;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { ...placement };
    const ratio = aspectRatio(placement.assetId);
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      const deltaX = (move.clientX - startX) / stageWidth;
      const deltaY = (move.clientY - startY) / stageHeight;

      if (mode === "move") {
        const heightFraction = (start.width * stageWidth * ratio) / stageHeight;
        placement.x = clamp(start.x + deltaX, 0, 1 - start.width);
        placement.y = clamp(start.y + deltaY, 0, Math.max(0, 1 - heightFraction));
      } else {
        const width = clamp(start.width + deltaX, 0.02, 1 - start.x);
        const heightFraction = (width * stageWidth * ratio) / stageHeight;
        // Don't let the corner drag push the box off the bottom edge.
        if (start.y + heightFraction <= 1) placement.width = width;
      }
      renderPlacements();
    };

    const onUp = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  /**
   * Adds a placement of `assetId` on the current page, centred on
   * (`centreX`, `centreY`) in fractions of the page - or in the middle of it
   * when no point is given.
   */
  function place(assetId: number, centreX = 0.5, centreY = 0.5): void {
    if (currentPage === null) return;
    const rect = pageImg.getBoundingClientRect();
    const width = 0.25;
    const heightFraction = (width * rect.width * aspectRatio(assetId)) / rect.height;

    const placement: Placement = {
      id: nextId++,
      assetId,
      page: currentPage,
      x: clamp(centreX - width / 2, 0, 1 - width),
      y: clamp(centreY - heightFraction / 2, 0, Math.max(0, 1 - heightFraction)),
      width,
    };
    placements.push(placement);
    select(placement.id);
    syncPageBadges();
  }

  // Clicking the bare page clears the selection.
  stage.addEventListener("pointerdown", () => select(null));

  // --- Dropping an asset from the palette onto the page ---
  // Native HTML5 drag & drop is safe here: unlike the editor, this panel has
  // no page reordering to collide with.
  stage.addEventListener("dragover", (event) => {
    if (currentPage === null) return;
    event.preventDefault();
    (event as DragEvent).dataTransfer!.dropEffect = "copy";
  });

  stage.addEventListener("drop", (event) => {
    const dragEvent = event as DragEvent;
    dragEvent.preventDefault();
    if (currentPage === null) return;

    if (draggingAssetId === null) return;
    if (!assetById(draggingAssetId)) return;

    // The drop point becomes the centre of the box - that's where the cursor is.
    const rect = pageImg.getBoundingClientRect();
    place(draggingAssetId, (dragEvent.clientX - rect.left) / rect.width, (dragEvent.clientY - rect.top) / rect.height);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (selectedId === null) return;
    // Only when this panel is the visible one, and not while typing.
    if (byId<HTMLElement>("panel-annota").hidden) return;
    const target = event.target as HTMLElement | null;
    if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    event.preventDefault();
    removeSelected();
  });

  function removeSelected(): void {
    placements = placements.filter((placement) => placement.id !== selectedId);
    select(null);
    syncPageBadges();
  }

  deleteButton.addEventListener("click", () => removeSelected());

  allPagesButton.addEventListener("click", () => {
    const selected = placements.find((placement) => placement.id === selectedId);
    if (!selected) return;
    for (let page = 1; page <= pageCount; page++) {
      if (page === selected.page) continue;
      placements.push({ ...selected, id: nextId++, page });
    }
    syncPageBadges();
    setStatus(status, `Fatto: annotazione replicata su ${pageCount} pagine`, "ok");
  });

  async function selectPage(page: number): Promise<void> {
    if (!pdfBytes) return;
    currentPage = page;
    for (const thumb of Array.from(pagesEl.querySelectorAll(".annota-thumb"))) {
      thumb.classList.toggle("selected", Number((thumb as HTMLElement).dataset.page) === page);
    }
    // Rendered bigger than the thumbnails: this is the one you aim with. CSS
    // caps how tall it displays; the placements' percentages are read off the
    // displayed size, so the two stay consistent.
    const png = await render_page_preview(pdfBytes, page, 0.7);
    pageImg.src = bytesToObjectUrl(png, "image/png");
    stage.hidden = false;
    await pageImg.decode().catch(() => undefined);
    select(null);
  }

  setupFileInput(byId<HTMLElement>("annota-drop"), byId<HTMLInputElement>("annota-input"), (files) => {
    const file = files[0];
    if (!file) return;
    pdfName = file.name;
    byId<HTMLElement>("annota-filename").textContent = file.name;

    void runWithStatus(status, async () => {
      pagesEl.innerHTML = "";
      stage.hidden = true;
      currentPage = null;
      // A new document invalidates every placement: they point at page numbers.
      placements = [];
      selectedId = null;

      pdfBytes = await fileToUint8Array(file);
      pageCount = await page_count(pdfBytes);

      const thumbs = new Map<number, HTMLImageElement>();
      for (let page = 1; page <= pageCount; page++) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "annota-thumb";
        button.dataset.page = String(page);
        const img = document.createElement("img");
        const label = document.createElement("span");
        label.textContent = `Pagina ${page}`;
        const badge = document.createElement("span");
        badge.className = "count";
        badge.hidden = true;
        button.append(img, label, badge);
        button.addEventListener("click", () => void runWithStatus(status, () => selectPage(page)));
        pagesEl.appendChild(button);
        thumbs.set(page, img);
      }

      const fill = (page: number, png: Uint8Array) => {
        const img = thumbs.get(page);
        if (img) img.src = bytesToObjectUrl(png, "image/png");
      };

      const bytes = pdfBytes;
      if (pageCount > PARALLEL_PREVIEW_THRESHOLD) {
        await renderPagesInParallel(bytes, Array.from({ length: pageCount }, (_, index) => index + 1), 0.25, fill);
      } else {
        for (let page = 1; page <= pageCount; page++) fill(page, await render_page_preview(bytes, page, 0.25));
      }

      await selectPage(1);
      setStatus(status, `Fatto: ${pageCount} pagine, scegli quella da annotare`, "ok");
    });
  });

  setupFileInput(
    byId<HTMLElement>("annota-image-drop"),
    byId<HTMLInputElement>("annota-image-input"),
    (files) => {
      if (files.length === 0) return;
      void runWithStatus(status, async () => {
        let warned = false;
        for (const file of files) {
          const image = await imageToRgba(file);
          if (!hasTransparency(image)) warned = true;

          const asset: Asset = { id: nextId++, name: file.name, objectUrl: URL.createObjectURL(file), image };
          assets.push(asset);

          const card = document.createElement("div");
          card.className = "annota-asset";
          card.draggable = true;
          card.title = `${file.name} — trascinala sulla pagina`;
          const img = document.createElement("img");
          img.src = asset.objectUrl;
          img.draggable = false;
          const label = document.createElement("span");
          label.textContent = file.name;
          card.append(img, label);
          card.addEventListener("dragstart", (event) => {
            draggingAssetId = asset.id;
            // Some payload has to be set for a drag to start at all in some
            // browsers; what it holds doesn't matter, the id is read above.
            (event as DragEvent).dataTransfer?.setData("text/plain", asset.name);
          });
          card.addEventListener("dragend", () => {
            draggingAssetId = null;
          });
          // Clicking is the same thing without the drag: it drops the image in
          // the middle of the current page, from where it can be moved. Keeps
          // the panel usable without a pointer - and dragging is awkward to
          // drive from a test.
          card.addEventListener("click", () => {
            if (currentPage === null) {
              setStatus(status, "Scegli prima una pagina", "error");
              return;
            }
            place(asset.id);
          });
          paletteEl.appendChild(card);
        }

        syncToolbar();
        const warning = warned ? " (attenzione: un'immagine non ha trasparenza, coprirà il testo sotto)" : "";
        setStatus(status, `Fatto: ${files.length} immagini caricate, trascinale sulla pagina${warning}`, "ok");
      });
    },
    (file) => file.type === "image/png",
  );

  byId<HTMLButtonElement>("annota-run").addEventListener("click", () =>
    void runWithStatus(status, async () => {
      if (!pdfBytes) throw new Error("seleziona un PDF");
      if (placements.length === 0) throw new Error("trascina almeno un'immagine su una pagina");

      // Only the assets actually placed are sent, and each one once - the
      // wasm side turns each into a single shared XObject.
      const usedIds = Array.from(new Set(placements.map((placement) => placement.assetId)));
      const used = usedIds.map((id) => assetById(id)).filter((asset): asset is Asset => Boolean(asset));

      const annotations: Annotation[] = placements.map((placement) => ({
        page: placement.page,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        kind: "image",
        asset: usedIds.indexOf(placement.assetId),
      }));

      // Copies: the worker *transfers* these buffers and neuters ours, and
      // we want to stay able to apply again without reloading anything.
      const annotated = await annotate_pdf(
        new Uint8Array(pdfBytes),
        used.map((asset) => new Uint8Array(asset.image.pixels)),
        used.map((asset) => ({ width: asset.image.width, height: asset.image.height })),
        annotations,
      );

      downloadBytes(annotated, pdfName.replace(/\.pdf$/i, "") + "-annotato.pdf");
      setStatus(status, `Fatto: ${placements.length} annotazioni applicate`, "ok");
    }),
  );

  syncToolbar();
}
