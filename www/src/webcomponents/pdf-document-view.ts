import { downloadBytes } from "../pdf-io";
import type { PdfDocument } from "../pdf-model/PdfDocument";
import type { CardData, PageActionDetail, PageDragOverDetail, PdfPageCard } from "./pdf-page-card";

export interface PreviewProgressDetail {
  done: number;
  total: number;
}

/**
 * Above this many pages, `refresh()` switches from eagerly rendering every
 * page up front to a virtual-scroll strategy: a placeholder card per page,
 * with previews fetched only as cards actually scroll into view. Chosen to
 * match `PdfEditor`'s own eager-render assumption staying cheap below it -
 * see docs/development.md for the full rationale.
 */
export const VIRTUAL_SCROLL_THRESHOLD = 24;

/** Positions further apart than this get their own separate `getPreviews` range call instead of being pulled into the same one (which would render everything in between too). */
const MAX_RANGE_GAP = 3;

/**
 * Wraps one `PdfDocument`: renders its pages as `<pdf-page-card>` thumbnails,
 * applies rotate/delete actions from those cards, and exposes commit/export.
 * Set the document with `view.setDocument(doc, label)` - a plain property
 * setter can't be `async` (rendering the previews is), so this is a method
 * instead.
 */
export class PdfDocumentView extends HTMLElement {
  private readonly root: ShadowRoot;
  private doc: PdfDocument | null = null;
  private label = "";
  // Dedupes "page-drag-over": it fires repeatedly (many times a second)
  // while the pointer sits over the same card, and re-running the reorder
  // for a target we already handled would be wasted work (harmless, since
  // the FLIP animation below is a no-op for a card that hasn't moved, but
  // still pointless `movePage` calls).
  private lastDragOverTargetId: number | null = null;
  // Only set while the virtual-scroll path (see VIRTUAL_SCROLL_THRESHOLD) is
  // active - torn down and rebuilt on every refresh() so a stale observer
  // never fires on cards that no longer belong to the current document.
  private virtualObserver: IntersectionObserver | null = null;
  private cardsByPosition = new Map<number, PdfPageCard>();
  private positionByCard = new Map<PdfPageCard, number>();
  private pendingPositions = new Set<number>();
  private flushScheduled = false;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>
        .toolbar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; }
        .toolbar h3 { margin: 0; font-size: 1rem; flex: 1; min-width: 8rem; }
        button { padding: 0.35rem 0.75rem; cursor: pointer; }
        .grid { display: flex; flex-wrap: wrap; gap: 1.5rem; padding: 0.25rem; }
        .status { margin-top: 0.5rem; font-size: 0.85rem; color: #666; }
        .status--error { color: #dc2626; }
        .empty { color: #888; font-size: 0.9rem; }
      </style>
      <div class="toolbar">
        <h3></h3>
        <button type="button" data-action="commit">Conferma modifiche</button>
        <button type="button" data-action="export">Scarica anteprima risultato</button>
        <button type="button" data-action="download">Scarica documento</button>
      </div>
      <div class="grid"></div>
      <p class="empty" hidden>Nessun documento selezionato.</p>
      <div class="status"></div>
    `;
    this.root.addEventListener("page-action", (event) => this.handlePageAction(event as CustomEvent<PageActionDetail>));
    this.root.addEventListener("page-drag-over", (event) => this.handlePageDragOver(event as CustomEvent<PageDragOverDetail>));
    this.root.addEventListener("dragend", () => {
      this.lastDragOverTargetId = null;
    });
    this.root.querySelector('[data-action="commit"]')?.addEventListener("click", () => this.commit());
    this.root.querySelector('[data-action="export"]')?.addEventListener("click", () => this.exportPreview());
    this.root.querySelector('[data-action="download"]')?.addEventListener("click", () => this.downloadCurrent());
  }

  async setDocument(doc: PdfDocument, label: string): Promise<void> {
    this.doc = doc;
    this.label = label;
    (this.root.querySelector("h3") as HTMLElement).textContent = `${label} (${doc.getPageCount()} pagine)`;
    (this.root.querySelector(".empty") as HTMLElement).hidden = true;
    await this.refresh();
  }

  private setStatus(message: string, isError = false): void {
    const el = this.root.querySelector(".status") as HTMLElement;
    el.textContent = message;
    el.classList.toggle("status--error", isError);
  }

  private async refresh(): Promise<void> {
    if (!this.doc) return;

    // Any observer from a previous refresh() is watching cards that are
    // about to be thrown away (or, below threshold, watching nothing at all
    // this time) - always tear it down up front rather than only in the
    // virtual branch below.
    this.virtualObserver?.disconnect();
    this.virtualObserver = null;

    if (this.doc.getPageCount() > VIRTUAL_SCROLL_THRESHOLD) {
      this.refreshVirtual();
      return;
    }

    this.setStatus("Rendering anteprime…");
    this.emitProgress(0, this.doc.getPageCount());
    try {
      const previews = await this.doc.getPreviews(0.3, {
        onProgress: (done, total) => {
          this.setStatus(`Rendering anteprime… (${done}/${total})`);
          this.emitProgress(done, total);
        },
      });
      const grid = this.root.querySelector(".grid") as HTMLElement;
      grid.innerHTML = "";
      for (const preview of previews) {
        const card = document.createElement("pdf-page-card") as PdfPageCard;
        card.data = preview;
        grid.appendChild(card);
      }
      this.setStatus("");
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  /**
   * Above VIRTUAL_SCROLL_THRESHOLD: renders a placeholder card for every
   * page immediately (cheap - `pages()` is sync, in-memory metadata only,
   * no wasm call), then lazily fills in each card's real PNG only once it
   * actually scrolls into view, via `getPreviews({ range })` - which already
   * reuses the cache and fetches only what's missing.
   *
   * Deliberately does not emit `preview-progress`: this document was never
   * going to be "fully rendered" as a single event, so the doclist pill for
   * it stays neutral instead of showing a misleading 100%-and-done state.
   */
  private refreshVirtual(): void {
    if (!this.doc) return;
    const pages = this.doc.pages();
    this.setStatus(`Documento grande (${pages.length} pagine): le anteprime si caricano scorrendo.`);

    this.cardsByPosition = new Map();
    this.positionByCard = new Map();
    this.pendingPositions.clear();

    const grid = this.root.querySelector(".grid") as HTMLElement;
    grid.innerHTML = "";

    const observer = new IntersectionObserver((entries) => this.handleIntersect(entries), {
      root: null,
      // Prefetches a bit before a card is actually visible, so the image is
      // usually already there by the time the user scrolls it fully into view.
      rootMargin: "600px 0px",
    });
    this.virtualObserver = observer;

    pages.forEach((info, index) => {
      const position = index + 1;
      const card = document.createElement("pdf-page-card") as PdfPageCard;
      card.data = info;
      grid.appendChild(card);
      this.cardsByPosition.set(position, card);
      this.positionByCard.set(card, position);
      observer.observe(card);
    });
  }

  private handleIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const position = this.positionByCard.get(entry.target as PdfPageCard);
      if (position !== undefined) this.pendingPositions.add(position);
    }
    if (this.pendingPositions.size > 0 && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushPendingPositions());
    }
  }

  private async flushPendingPositions(): Promise<void> {
    this.flushScheduled = false;
    if (!this.doc || this.pendingPositions.size === 0) return;

    const positions = Array.from(this.pendingPositions).sort((a, b) => a - b);
    this.pendingPositions.clear();

    // Group nearby positions into runs so one call covers a scrolled-past
    // stretch of pages, instead of one `getPreviews` call per card - but cap
    // how far a gap can stretch a run, so jumping from page 1 to page 100
    // doesn't turn into "render everything in between".
    const runs: Array<[number, number]> = [];
    for (const position of positions) {
      const current = runs[runs.length - 1];
      if (current && position - current[1] <= MAX_RANGE_GAP) current[1] = position;
      else runs.push([position, position]);
    }

    const doc = this.doc;
    await Promise.all(
      runs.map(([start, end]) =>
        doc.getPreviews(0.3, { range: { start, end } }).then((previews) => {
          previews.forEach((preview, offset) => {
            const card = this.cardsByPosition.get(start + offset);
            if (!card) return;
            card.data = preview;
            this.virtualObserver?.unobserve(card);
          });
        }),
      ),
    );
  }

  disconnectedCallback(): void {
    this.virtualObserver?.disconnect();
  }

  /**
   * Reports rendering progress upward instead of showing it itself - the
   * example UI (`<pdf-editor-app>`) displays it as a fill on the active
   * document's pill in the doc list, right under the dropzone, not here.
   */
  private emitProgress(done: number, total: number): void {
    this.dispatchEvent(
      new CustomEvent<PreviewProgressDetail>("preview-progress", { detail: { done, total }, bubbles: true, composed: true }),
    );
  }

  /** Rotate/delete only ever touch this document's in-memory pending state - no wasm call, so just re-render the one affected card. */
  private handlePageAction(event: CustomEvent<PageActionDetail>): void {
    if (!this.doc) return;
    const { id, action } = event.detail;

    try {
      if (action === "rotate-left") this.doc.rotatePage(id, -90);
      else if (action === "rotate-right") this.doc.rotatePage(id, 90);
      else if (action === "toggle-delete") {
        const info = this.doc.pages().find((p) => p.id === id);
        if (info?.markedForDeletion) this.doc.restorePage(id);
        else this.doc.deletePage(id);
      }
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }

    const updated = this.doc.pages().find((p) => p.id === id);
    const card = Array.from(this.root.querySelectorAll("pdf-page-card")).find(
      (el) => (el as PdfPageCard).data?.id === id,
    ) as PdfPageCard | undefined;
    if (card && updated) {
      // Works whether the card currently holds a full PagePreview or (in the
      // virtual-scroll path) just a placeholder PageInfo - the spread keeps
      // `png` if it was there, and is a no-op addition if it wasn't.
      card.data = { ...(card.data as CardData), ...updated } as CardData;
    }
  }

  /**
   * Fires continuously while a card is dragged over another one (not just
   * once on drop) - applies the move to the model right away (in-memory
   * bookkeeping, no wasm call) and animates the grid to match, using the
   * FLIP technique (First/Last/Invert/Play): record every card's current
   * position, reorder the actual DOM nodes, then animate each one from
   * where it *was* to where it now is. That's what makes the cards visibly
   * slide out of the way while you drag, instead of only snapping into
   * place on drop.
   */
  private handlePageDragOver(event: CustomEvent<PageDragOverDetail>): void {
    if (!this.doc) return;
    const { draggedId, targetId } = event.detail;
    if (targetId === this.lastDragOverTargetId) return;
    this.lastDragOverTargetId = targetId;

    const targetIndex = this.doc.pages().findIndex((p) => p.id === targetId);
    if (targetIndex === -1) return;

    const grid = this.root.querySelector(".grid") as HTMLElement;
    const cards = Array.from(grid.querySelectorAll("pdf-page-card")) as PdfPageCard[];

    // FIRST: record where every card is right now.
    const firstRects = new Map(cards.map((card) => [card, card.getBoundingClientRect()]));

    try {
      this.doc.movePage(draggedId, targetIndex);
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }

    // Reorder the actual DOM nodes to match the model's new order.
    // `appendChild` on a node that's already in the tree just moves it.
    const cardById = new Map(cards.map((card) => [card.data?.id, card]));
    for (const info of this.doc.pages()) {
      const card = cardById.get(info.id);
      if (card) grid.appendChild(card);
    }

    // LAST + INVERT + PLAY: for each card, jump it back (via a transform)
    // to where it was, then let it transition to its real (zero) transform
    // on the next frame - it visibly slides from old position to new.
    for (const card of cards) {
      const first = firstRects.get(card);
      if (!first) continue;
      const last = card.getBoundingClientRect();
      const deltaX = first.left - last.left;
      const deltaY = first.top - last.top;
      if (deltaX === 0 && deltaY === 0) continue;

      card.style.transition = "none";
      card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      requestAnimationFrame(() => {
        card.style.transition = "transform 0.2s ease";
        card.style.transform = "";
      });
    }
  }

  private async commit(): Promise<void> {
    if (!this.doc) return;
    this.setStatus("Applico le modifiche…");
    try {
      await this.doc.commit();
      (this.root.querySelector("h3") as HTMLElement).textContent = `${this.label} (${this.doc.getPageCount()} pagine)`;
      await this.refresh();
      this.setStatus("Modifiche confermate.");
      this.dispatchEvent(new CustomEvent("document-committed", { bubbles: true, composed: true }));
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private async exportPreview(): Promise<void> {
    if (!this.doc) return;
    try {
      const bytes = await this.doc.exportBytes();
      downloadBytes(bytes, `${this.label}-anteprima.pdf`);
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private downloadCurrent(): void {
    if (!this.doc) return;
    downloadBytes(this.doc.getBytes(), this.label);
  }
}

customElements.define("pdf-document-view", PdfDocumentView);
