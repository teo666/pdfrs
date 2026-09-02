import { downloadBytes } from "../pdf-io";
import type { PdfDocument } from "../pdf-model/PdfDocument";
import type { PagePreview } from "../pdf-model/types";
import type { PageActionDetail, PageDragOverDetail, PdfPageCard } from "./pdf-page-card";

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
        progress { width: 100%; margin-top: 0.5rem; }
      </style>
      <div class="toolbar">
        <h3></h3>
        <button type="button" data-action="commit">Conferma modifiche</button>
        <button type="button" data-action="export">Scarica anteprima risultato</button>
        <button type="button" data-action="download">Scarica documento</button>
      </div>
      <div class="grid"></div>
      <p class="empty" hidden>Nessun documento selezionato.</p>
      <progress hidden value="0" max="1"></progress>
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
    const progress = this.root.querySelector("progress") as HTMLProgressElement;
    progress.hidden = false;
    progress.value = 0;
    progress.max = this.doc.getPageCount();
    this.setStatus("Rendering anteprime…");
    try {
      const previews = await this.doc.getPreviews(0.3, {
        onProgress: (done, total) => {
          progress.value = done;
          progress.max = total;
          this.setStatus(`Rendering anteprime… (${done}/${total})`);
        },
      });
      const grid = this.root.querySelector(".grid") as HTMLElement;
      grid.innerHTML = "";
      for (const preview of previews) {
        const card = document.createElement("pdf-page-card") as PdfPageCard;
        card.preview = preview;
        grid.appendChild(card);
      }
      this.setStatus("");
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      progress.hidden = true;
    }
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
      (el) => (el as PdfPageCard).preview?.id === id,
    ) as PdfPageCard | undefined;
    if (card && updated) {
      card.preview = { ...(card.preview as PagePreview), ...updated };
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
    const cardById = new Map(cards.map((card) => [card.preview?.id, card]));
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
