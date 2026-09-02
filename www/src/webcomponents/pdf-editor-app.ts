import { fileToUint8Array, isJpeg, isPdf, setupFileInput } from "../pdf-io";
import { PdfEditor } from "../pdf-model/PdfEditor";
import type { DocumentId } from "../pdf-model/types";
import type { PdfDocumentView } from "./pdf-document-view";

/**
 * Top-level example wiring `PdfEditor` (a registry of `PdfDocument`s) to a
 * visual UI: drop PDFs to open them, pick one to edit in the embedded
 * `<pdf-document-view>`, or merge several into a new document. Self-contained
 * (creates its own `PdfEditor`) so it can be dropped into a page as-is - a
 * preview of how a real frontend (e.g. the future Vue app) would wrap these
 * same classes.
 */
export class PdfEditorApp extends HTMLElement {
  private readonly root: ShadowRoot;
  private readonly editor = new PdfEditor();
  private readonly labels = new Map<DocumentId, string>();
  private readonly selectedForMerge = new Set<DocumentId>();
  private activeId: DocumentId | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>
        .dropzone { border: 2px dashed #8888; border-radius: 6px; padding: 1rem; text-align: center; cursor: pointer; color: #666; margin-bottom: 0.75rem; }
        .dropzone--active { border-color: #3b82f6; color: #3b82f6; background: #3b82f611; }
        .doclist { list-style: none; padding: 0; margin: 0 0 0.75rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .doclist li { display: flex; align-items: center; gap: 0.3rem; border: 1px solid #8884; border-radius: 999px; padding: 0.25rem 0.6rem; font-size: 0.85rem; }
        .doclist li.active { border-color: #3b82f6; background: #3b82f611; }
        .doclist button { background: none; border: none; cursor: pointer; padding: 0; font: inherit; }
        .merge-row { margin-bottom: 1rem; }
        .status { font-size: 0.85rem; color: #666; margin-bottom: 0.75rem; }
        .status--error { color: #dc2626; }
      </style>
      <div class="dropzone" data-el="dropzone">Trascina uno o più PDF o JPEG qui, o clicca per aprirli nell'editor</div>
      <input type="file" accept="application/pdf,image/jpeg" multiple hidden data-el="input" />
      <ul class="doclist" data-el="doclist"></ul>
      <div class="merge-row">
        <button type="button" data-action="merge">Unisci i documenti selezionati</button>
      </div>
      <div class="status" data-el="status"></div>
      <pdf-document-view></pdf-document-view>
    `;

    const dropzone = this.root.querySelector('[data-el="dropzone"]') as HTMLElement;
    const input = this.root.querySelector('[data-el="input"]') as HTMLInputElement;
    setupFileInput(dropzone, input, (files) => void this.addFiles(files), (file) => isPdf(file) || isJpeg(file));

    this.root.querySelector('[data-action="merge"]')?.addEventListener("click", () => void this.mergeSelected());
    this.root.addEventListener("document-committed", () => this.renderDocList());
  }

  private setStatus(message: string, isError = false): void {
    const el = this.root.querySelector('[data-el="status"]') as HTMLElement;
    el.textContent = message;
    el.classList.toggle("status--error", isError);
  }

  private async addFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const bytes = await fileToUint8Array(file);
        // JPEGs go through addImage (image_to_pdf under the hood) instead of
        // addDocument - from here on the resulting document is a PdfDocument
        // like any other, mergeable with real PDFs with no extra handling.
        const id = isJpeg(file) ? await this.editor.addImage(bytes) : await this.editor.addDocument(bytes);
        this.labels.set(id, file.name);
        if (this.activeId === null) this.activeId = id;
      } catch (err) {
        this.setStatus(`Errore aprendo ${file.name}: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    }
    this.renderDocList();
    await this.renderActive();
  }

  private renderDocList(): void {
    const list = this.root.querySelector('[data-el="doclist"]') as HTMLElement;
    list.innerHTML = "";

    for (const { id, pageCount } of this.editor.listDocuments()) {
      const item = document.createElement("li");
      if (id === this.activeId) item.classList.add("active");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedForMerge.has(id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedForMerge.add(id);
        else this.selectedForMerge.delete(id);
      });

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${this.labels.get(id) ?? `documento-${id}`} (${pageCount}p)`;
      button.addEventListener("click", () => void this.selectDocument(id));

      item.append(checkbox, button);
      list.appendChild(item);
    }
  }

  private async selectDocument(id: DocumentId): Promise<void> {
    this.activeId = id;
    this.renderDocList();
    await this.renderActive();
  }

  private async renderActive(): Promise<void> {
    const view = this.root.querySelector("pdf-document-view") as PdfDocumentView | null;
    if (!view || this.activeId === null) return;
    await view.setDocument(this.editor.getDocument(this.activeId), this.labels.get(this.activeId) ?? `documento-${this.activeId}`);
  }

  private async mergeSelected(): Promise<void> {
    const ids = Array.from(this.selectedForMerge);
    if (ids.length < 2) {
      this.setStatus("Seleziona almeno due documenti da unire (checkbox accanto al nome).", true);
      return;
    }

    try {
      const mergedId = await this.editor.mergeDocuments(ids);
      this.labels.set(mergedId, `merged-${mergedId}.pdf`);
      this.selectedForMerge.clear();
      this.activeId = mergedId;
      this.setStatus(`Fatto: ${ids.length} documenti uniti in un nuovo documento.`);
      this.renderDocList();
      await this.renderActive();
    } catch (err) {
      this.setStatus(`Errore: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
}

customElements.define("pdf-editor-app", PdfEditorApp);
