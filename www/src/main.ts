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
} from "./pdfrs-worker-client";
import { bytesToObjectUrl, downloadBytes, fileToUint8Array, setupFileInput } from "./pdf-io";
import { parseLayout, parseRanges, parseRotations } from "./parsers";
import { renderPagesInParallel } from "./preview-worker-pool";

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

      const fillCard = (page: number, png: Uint8Array) => {
        const img = cardImages.get(page);
        if (img) img.src = bytesToObjectUrl(png, "image/png");
      };

      if (count > PARALLEL_PREVIEW_THRESHOLD) {
        await renderPagesInParallel(bytes, count, 0.4, fillCard);
      } else {
        for (let page = 1; page <= count; page++) {
          fillCard(page, await render_page_preview(bytes, page, 0.4));
        }
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
