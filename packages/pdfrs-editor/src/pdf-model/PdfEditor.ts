import { merge_pdfs, split_pdf } from "../worker/pdfrs-worker-client";
import { PdfDocument } from "./PdfDocument";
import type { DocumentId, ImagePageOptions, PageId } from "./types";

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
   * Copies some pages of a document, in the order given and with their
   * pending rotations applied, into a new managed document (see
   * `PdfDocument.exportPages`). The source document is not modified.
   *
   * Previews already rendered for pages that come out unchanged (no pending
   * rotation) are carried over, like `mergeDocuments` does.
   */
  async extractPages(id: DocumentId, pageIds: PageId[]): Promise<DocumentId> {
    const source = this.getDocument(id);
    const extractedId = await this.addDocument(await source.exportPages(pageIds));
    const extracted = this.getDocument(extractedId);

    const rotated = new Set(source.pages().filter((p) => p.pendingRotation !== 0).map((p) => p.id));
    [...new Set(pageIds)].forEach((page, index) => {
      if (rotated.has(page)) return;
      for (const [scale, png] of source.cachedEntriesForPage(page)) {
        extracted.primeCache(index + 1, scale, png);
      }
    });

    return extractedId;
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
