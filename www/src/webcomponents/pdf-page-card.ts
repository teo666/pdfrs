import { bytesToObjectUrl } from "../pdf-io";
import type { PagePreview } from "../pdf-model/types";

export interface PageActionDetail {
  id: number;
  action: "rotate-left" | "rotate-right" | "toggle-delete";
}

/**
 * A single page thumbnail: shows the rendered PNG (rotated via CSS to
 * reflect `pendingRotation` - `PdfDocument` never re-renders the bitmap
 * itself for a pending rotation, see docs/development.md), dims it when
 * `markedForDeletion`, and exposes rotate/delete controls that dispatch a
 * `page-action` event instead of touching PdfDocument directly - the parent
 * `<pdf-document-view>` owns the document instance and reacts to that event.
 */
export class PdfPageCard extends HTMLElement {
  private readonly root: ShadowRoot;
  private preview_: PagePreview | null = null;
  private objectUrl: string | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>
        .card { width: 150px; border: 1px solid #8884; border-radius: 6px; padding: 0.4rem; text-align: center; font: inherit; }
        .card--deleted { opacity: 0.4; }
        .thumb { width: 100%; height: 170px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .thumb img { max-width: 100%; max-height: 100%; transition: transform 0.15s; }
        .thumb img.rot-90, .thumb img.rot-270 { max-width: 170px; max-height: 100px; }
        .label { font-size: 0.75rem; color: #666; margin: 0.3rem 0; }
        .toolbar { display: flex; gap: 0.25rem; justify-content: center; }
        button { font-size: 0.85rem; padding: 0.2rem 0.4rem; cursor: pointer; }
      </style>
      <div class="card">
        <div class="thumb"><img alt="" /></div>
        <div class="label"></div>
        <div class="toolbar">
          <button type="button" data-action="rotate-left" title="Ruota a sinistra">⟲</button>
          <button type="button" data-action="rotate-right" title="Ruota a destra">⟳</button>
          <button type="button" data-action="toggle-delete"></button>
        </div>
      </div>
    `;
    this.root.addEventListener("click", (event) => this.handleClick(event as MouseEvent));
  }

  set preview(value: PagePreview) {
    this.preview_ = value;
    this.render();
  }

  get preview(): PagePreview | null {
    return this.preview_;
  }

  disconnectedCallback(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  private render(): void {
    const preview = this.preview_;
    if (!preview) return;

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = bytesToObjectUrl(preview.png, "image/png");

    const card = this.root.querySelector(".card") as HTMLElement;
    const img = this.root.querySelector("img") as HTMLImageElement;
    const label = this.root.querySelector(".label") as HTMLElement;
    const deleteBtn = this.root.querySelector('[data-action="toggle-delete"]') as HTMLButtonElement;

    card.classList.toggle("card--deleted", preview.markedForDeletion);
    img.src = this.objectUrl;
    img.alt = `Pagina ${preview.id}`;
    img.style.transform = `rotate(${preview.pendingRotation}deg)`;
    img.classList.toggle("rot-90", preview.pendingRotation === 90 || preview.pendingRotation === 270);
    img.classList.toggle("rot-270", preview.pendingRotation === 90 || preview.pendingRotation === 270);
    label.textContent = `Pagina ${preview.id}${preview.pendingRotation ? ` (${preview.pendingRotation}°)` : ""}`;
    deleteBtn.textContent = preview.markedForDeletion ? "Ripristina" : "Elimina";
  }

  private handleClick(event: MouseEvent): void {
    const button = (event.target as HTMLElement).closest("button");
    const action = button?.dataset.action as PageActionDetail["action"] | undefined;
    if (!action || !this.preview_) return;

    this.dispatchEvent(
      new CustomEvent<PageActionDetail>("page-action", {
        detail: { id: this.preview_.id, action },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define("pdf-page-card", PdfPageCard);
