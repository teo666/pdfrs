import { decrypt_pdf, encrypt_pdf, merge_pdfs, split_pdf, write_outline } from "../worker/pdfrs-worker-client";
import { PdfDocument } from "./PdfDocument";
import type { DocumentId, ImagePageOptions, OutlineEntry, PageId } from "./types";

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
  async mergeDocuments(
    ids: DocumentId[],
    options: { applyPending?: boolean; titles?: string[] } = {},
  ): Promise<DocumentId> {
    const sources = ids.map((id) => this.getDocument(id));
    if (options.applyPending) return this.mergeAsShown(sources, options.titles);

    let merged = await merge_pdfs(sources.map((doc) => doc.getBytes()));
    merged = await withBranches(
      merged,
      await Promise.all(
        sources.map(async (doc) => ({ pages: doc.getPageCount(), outline: await doc.getOutline() })),
      ),
      options.titles,
    );
    const mergedId = await this.addDocument(merged);
    const mergedDoc = this.getDocument(mergedId);

    let offset = 0;
    for (const source of sources) {
      for (let page = 1; page <= source.getPageCount(); page++) {
        for (const [scale, png] of source.cachedEntriesForPage(page)) {
          mergedDoc.primeCache(offset + page, scale, png);
        }
        const photo = source.photoSource(page);
        if (photo) mergedDoc.adoptPhoto(offset + page, photo);
      }
      offset += source.getPageCount();
    }

    return mergedId;
  }

  /**
   * `mergeDocuments` with `applyPending`: each source as it currently looks
   * (`exportBytes()`: order, rotations and deletions applied). Previews carry
   * over for the pages that come out unchanged - same picture, no rotation.
   */
  private async mergeAsShown(sources: PdfDocument[], titles?: string[]): Promise<DocumentId> {
    let merged = await merge_pdfs(await Promise.all(sources.map((doc) => doc.exportBytes())));
    merged = await withBranches(
      merged,
      await Promise.all(
        sources.map(async (doc) => ({
          pages: doc.pages().filter((page) => !page.markedForDeletion).length,
          outline: await doc.getOutlineAsShown(),
        })),
      ),
      titles,
    );
    const mergedId = await this.addDocument(merged);
    const mergedDoc = this.getDocument(mergedId);

    let position = 0;
    for (const source of sources) {
      const changed = changedPages(source);
      for (const page of source.pages()) {
        if (page.markedForDeletion) continue;
        position += 1;
        if (changed.has(page.id)) continue;
        for (const [scale, png] of source.cachedEntriesForPage(page.id)) {
          mergedDoc.primeCache(position, scale, png);
        }
        // A photo page that comes out as its photo alone can still change page there.
        const photo = source.photoSource(page.id);
        if (photo) mergedDoc.adoptPhoto(position, photo);
      }
    }

    return mergedId;
  }

  /**
   * Copies pages from one document into another (see
   * `PdfDocument.insertPages`), as they look in the source: in the order
   * given, pending rotations applied. With `move`, they're then marked for
   * deletion in the source - an ordinary pending edit there, undoable on its
   * own. Previews of unrotated pages travel along.
   */
  async transferPages(
    fromId: DocumentId,
    pageIds: PageId[],
    toId: DocumentId,
    options: { at?: number; move?: boolean } = {},
  ): Promise<PageId[]> {
    if (fromId === toId) throw new Error("origine e destinazione sono lo stesso documento");
    const source = this.getDocument(fromId);
    const target = this.getDocument(toId);
    const pages = [...new Set(pageIds)];
    const bytes = await source.exportPages(pages);
    const count = pages.length === 1 ? "1 pagina" : `${pages.length} pagine`;
    const inserted = await target.insertPages(bytes, options.at, `Inserisci ${count} da un altro documento`);

    const changed = changedPages(source);
    pages.forEach((page, index) => {
      const newId = inserted[index];
      if (newId === undefined || changed.has(page)) return;
      for (const [scale, png] of source.cachedEntriesForPage(page)) target.primeCache(newId, scale, png);
      const photo = source.photoSource(page);
      if (photo) target.adoptPhoto(newId, photo);
    });

    if (options.move) source.deletePages(pages);
    return inserted;
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

    const changed = changedPages(source);
    [...new Set(pageIds)].forEach((page, index) => {
      if (changed.has(page)) return;
      for (const [scale, png] of source.cachedEntriesForPage(page)) {
        extracted.primeCache(index + 1, scale, png);
      }
      const photo = source.photoSource(page);
      if (photo) extracted.adoptPhoto(index + 1, photo);
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

  /**
   * A password-protected copy of a document, as it looks now (pending edits
   * applied), registered as a new document - locked, see
   * `PdfDocument.isLocked`. The source stays as it is. AES-256; `password`
   * opens the copy, `ownerPassword` (the same one unless given) is the
   * owner's.
   */
  async protectDocument(id: DocumentId, password: string, ownerPassword = password): Promise<DocumentId> {
    const source = this.getDocument(id);
    if (source.isLocked()) throw new Error("il documento è già protetto da password");
    if (!password) throw new Error("serve una password");
    return this.addDocument(await encrypt_pdf(await source.exportBytes(), ownerPassword, password));
  }

  /**
   * A readable copy of a locked document, without the password, registered
   * as a new document. Either the password to open it or the owner's will
   * do. A wrong one throws an error saying so.
   */
  async unlockDocument(id: DocumentId, password: string): Promise<DocumentId> {
    const source = this.getDocument(id);
    let bytes: Uint8Array;
    try {
      bytes = await decrypt_pdf(source.getBytes(), password);
    } catch (err) {
      if (err instanceof Error && /invalid password/i.test(err.message)) throw new WrongPasswordError();
      throw err;
    }
    return this.addDocument(bytes);
  }
}

/** Thrown by `PdfEditor.unlockDocument` when the password doesn't open the document. */
export class WrongPasswordError extends Error {
  constructor() {
    super("password errata");
    this.name = "WrongPasswordError";
  }
}

/**
 * A merged document's outline: one entry per source, named after it
 * (`titles`, else "Documento n"), leading to its first page, with the
 * source's own outline inside - so the outline is also a map of the merge.
 * `parts` gives each source's page count and outline (page numbers within
 * it), in merge order.
 */
async function withBranches(
  merged: Uint8Array,
  parts: { pages: number; outline: OutlineEntry[] }[],
  titles: string[] = [],
): Promise<Uint8Array> {
  const entries: OutlineEntry[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    entries.push({
      title: titles[index] ?? `Documento ${index + 1}`,
      level: 1,
      page: part.pages > 0 ? offset + 1 : null,
      open: true,
    });
    for (const entry of part.outline) {
      entries.push({ ...entry, level: entry.level + 1, page: entry.page == null ? null : offset + entry.page });
    }
    offset += part.pages;
  });
  return write_outline(merged, entries);
}

/** Pages whose exported picture differs from their cached preview: rotated or annotated. */
function changedPages(doc: PdfDocument): Set<PageId> {
  const changed = doc.pagesWithAnnotations();
  for (const page of doc.pagesWithImageRemovals()) changed.add(page);
  for (const page of doc.pages()) if (page.pendingRotation !== 0) changed.add(page.id);
  return changed;
}
