import { merge_pdfs, split_pdf } from "../pdfrs-worker-client";
import { PdfDocument } from "./PdfDocument";
import type { DocumentId, ImagePageOptions } from "./types";

/**
 * Manages a collection of `PdfDocument`s and the operations that span more
 * than one of them (merge, split) - operations that don't belong inside a
 * single document's identity, since they inherently consume or produce
 * several documents at once.
 */
export class PdfEditor {
  private readonly documents = new Map<DocumentId, PdfDocument>();
  private nextId = 1;

  async addDocument(bytes: Uint8Array): Promise<DocumentId> {
    return this.register(await PdfDocument.open(bytes));
  }

  /** Converts a JPEG to a one-page document and registers it - from here on it's just another managed document, mergeable with any other. */
  async addImage(bytes: Uint8Array, options: ImagePageOptions = {}): Promise<DocumentId> {
    return this.register(await PdfDocument.fromImage(bytes, options));
  }

  private register(doc: PdfDocument): DocumentId {
    const id = this.nextId++;
    this.documents.set(id, doc);
    return id;
  }

  getDocument(id: DocumentId): PdfDocument {
    const doc = this.documents.get(id);
    if (!doc) throw new Error(`nessun documento con id ${id}`);
    return doc;
  }

  removeDocument(id: DocumentId): void {
    this.documents.delete(id);
  }

  listDocuments(): { id: DocumentId; pageCount: number }[] {
    return Array.from(this.documents.entries()).map(([id, doc]) => ({ id, pageCount: doc.getPageCount() }));
  }

  /**
   * Concatenates the given documents' pages, in order, into a new managed
   * document. Uses each source document's last *committed* baseline
   * (`getBytes()`) - commit pending rotations/deletions on a source first if
   * they should be reflected in the merge.
   *
   * Carries over already-rendered previews from the sources into the new
   * document's cache: `merge_pdfs` places source N's pages 1..count right
   * after source N-1's, in order, so which final page number corresponds to
   * which (source, original page) is known here without asking anything -
   * a page that was already previewed doesn't need rendering again just
   * because it now lives in a different document.
   */
  async mergeDocuments(ids: DocumentId[]): Promise<DocumentId> {
    const sources = ids.map((id) => this.getDocument(id));
    const merged = await merge_pdfs(sources.map((doc) => doc.getBytes()));
    const mergedId = await this.addDocument(merged);
    const mergedDoc = this.getDocument(mergedId);

    let offset = 0;
    for (const source of sources) {
      for (let page = 1; page <= source.getPageCount(); page++) {
        for (const [scale, png] of source.cachedEntriesForPage(page)) {
          mergedDoc.primeCache(offset + page, scale, png);
        }
      }
      offset += source.getPageCount();
    }

    return mergedId;
  }

  /**
   * Splits a document into several new managed documents, one per page
   * range. Uses the source document's last *committed* baseline
   * (`getBytes()`) - commit pending rotations/deletions first if they should
   * be reflected in the split.
   */
  async splitDocument(id: DocumentId, ranges: { start: number; end: number }[]): Promise<DocumentId[]> {
    const parts = await split_pdf(this.getDocument(id).getBytes(), ranges);
    const ids: DocumentId[] = [];
    for (const part of parts) {
      ids.push(await this.addDocument(part));
    }
    return ids;
  }
}
