import { merge_pdfs, split_pdf } from "../pdfrs-worker-client";
import { PdfDocument } from "./PdfDocument";
import type { DocumentId } from "./types";

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
    const doc = await PdfDocument.open(bytes);
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
   */
  async mergeDocuments(ids: DocumentId[]): Promise<DocumentId> {
    const buffers = ids.map((id) => this.getDocument(id).getBytes());
    const merged = await merge_pdfs(buffers);
    return this.addDocument(merged);
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
