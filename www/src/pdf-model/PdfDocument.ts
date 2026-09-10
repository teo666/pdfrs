import {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  image_to_pdf,
  page_count,
  read_metadata,
  render_page_preview,
  rotate_pages,
  write_metadata,
} from "../pdfrs-worker-client";
import { renderPagesInParallel } from "../preview-worker-pool";
import type {
  HistoryEntry,
  ImagePageOptions,
  MetadataField,
  MetadataPatch,
  PageId,
  PageInfo,
  PagePreview,
  PageRange,
  PdfMetadata,
} from "./types";

export interface GetPreviewsOptions {
  /** 1-indexed, inclusive window over the current *display order* (positions, not original page ids). Defaults to the whole document - set it to render only a window of a large document. */
  range?: PageRange;
  /** Fires after each page finishes (cache hits count as instantly "done" too), so callers can show real progress. */
  onProgress?: (done: number, total: number) => void;
}

/** Above this many pages, getPreviews() spreads rendering across a worker pool instead of the single shared worker. */
const PARALLEL_PREVIEW_THRESHOLD = 6;

/** How many undo steps are kept. Snapshots are cheap (see `DocumentSnapshot`) but each one pins a baseline `bytes` buffer, so the stack is bounded rather than unlimited. */
const MAX_HISTORY = 50;

interface PendingRotation {
  page: number;
  degrees: number;
}

/**
 * A full copy of everything mutable in a `PdfDocument`, i.e. everything
 * `undo()` has to be able to put back.
 *
 * It snapshots the *whole* state, not just the pending edits: `bytes` and
 * `pageCount` are in here too, so `commit()`/`encrypt()`/`decrypt()` - the
 * operations that rewrite the baseline - are undoable as well, and undoing
 * one is a pure reference swap with no wasm call. That's affordable because
 * only the containers are copied, never the bytes: PDF buffers and rendered
 * PNGs are never mutated in place (every operation produces a *new*
 * `Uint8Array`), so a snapshot holding the old ones costs one reference
 * each. Keeping `previewCache` along with the baseline it belongs to is what
 * makes an undone commit re-render instantly instead of re-rasterising every
 * page.
 */
interface DocumentSnapshot {
  /** What the user did to get *into* this state - the timeline is a list of these, not of the actions leading out of them. */
  label: string;
  bytes: Uint8Array;
  pageCount: number;
  rotations: Map<PageId, number>;
  deletions: Set<PageId>;
  order: PageId[];
  previewCache: Map<string, Uint8Array>;
  pendingMetadata: Map<MetadataField, string | null>;
  baselineMetadata: PdfMetadata | null;
}

/** Italian labels for the history entries, so a step reads "Modifica metadati (titolo)". */
const METADATA_LABELS: Record<MetadataField, string> = {
  title: "titolo",
  author: "autore",
  subject: "oggetto",
  keywords: "parole chiave",
  creator: "creatore",
  producer: "producer",
  creationDate: "data creazione",
  modDate: "data modifica",
};

const METADATA_FIELDS = Object.keys(METADATA_LABELS) as MetadataField[];

function cacheKey(id: PageId, scale: number): string {
  return `${id}:${scale}`;
}

function identityOrder(pageCount: number): PageId[] {
  return Array.from({ length: pageCount }, (_, index) => index + 1);
}

/**
 * Models one loaded PDF and the page-level edits the user hasn't confirmed
 * yet (rotate, delete, reorder). Pure logic - no DOM, no framework - meant to
 * be wrapped by whatever frontend renders it.
 *
 * Every mutating page method (rotatePage, deletePage, movePage, ...) only
 * updates this object's in-memory bookkeeping; nothing is sent to the wasm
 * module until `commit()` (or `exportBytes()`, which is the same computation
 * without mutating this instance).
 */
export class PdfDocument {
  private bytes: Uint8Array;
  private pageCount: number;
  private readonly rotations = new Map<PageId, number>();
  private readonly deletions = new Set<PageId>();
  // Keyed by `${page}:${scale}`. Rendered PNGs depend only on the current
  // baseline bytes, never on pending rotations/deletions (getPreview always
  // renders the baseline as-is - see its doc comment), so rotatePage/
  // deletePage/restorePage/resetRotation never need to touch this cache;
  // only a change to `bytes` itself (commit/encrypt/decrypt) invalidates it.
  private readonly previewCache = new Map<string, Uint8Array>();
  // The current display/output order, as a permutation of the original page
  // ids (e.g. [3, 1, 2] means "page 3 first, then 1, then 2"). Reordering
  // never touches `bytes`/the cache - it's bookkeeping only, applied for
  // real by `computeCommittedBytes()` via `compose_pdf`'s arbitrary layout.
  // Reset to identity ([1, 2, ..., pageCount]) whenever the baseline changes.
  private order: PageId[];
  // Snapshots of past states, oldest first; `redoStack` holds the states
  // undone away from, newest last. Any fresh mutation clears the redo stack
  // (standard semantics: acting after an undo drops the future).
  // Pending metadata edits, same idea as `rotations`/`deletions`: a field
  // present here overrides the baseline, `null` means "delete this key".
  private readonly pendingMetadata = new Map<MetadataField, string | null>();
  // What the baseline's /Info holds, read lazily on the first getMetadata()
  // call and cached like the previews are - `null` means "not read yet".
  // Invalidated wherever `previewCache` is, since it depends on exactly the
  // same thing: the baseline bytes.
  private baselineMetadata: PdfMetadata | null = null;
  private undoStack: DocumentSnapshot[] = [];
  private redoStack: DocumentSnapshot[] = [];
  // Describes how the *current* state was reached; moves onto a snapshot as
  // soon as that state becomes a past (or future) one.
  private currentLabel = "Documento aperto";

  private constructor(bytes: Uint8Array, pageCount: number) {
    this.bytes = bytes;
    this.pageCount = pageCount;
    this.order = identityOrder(pageCount);
  }

  /**
   * Opens a PDF. Only calls the cheap `page_count` - never renders a
   * preview eagerly, that stays behind an explicit `getPreview`/`getPreviews`
   * call.
   */
  static async open(bytes: Uint8Array): Promise<PdfDocument> {
    const count = await page_count(bytes);
    return new PdfDocument(bytes, count);
  }

  /**
   * Builds a one-page document from a JPEG (`options` picks the page size/
   * orientation - see `ImagePageOptions`). From here on it's a regular
   * `PdfDocument`: same rotate/delete/preview/commit, and indistinguishable
   * to `PdfEditor.mergeDocuments()` from a document opened from a real PDF -
   * that's what lets image pages and PDF pages be combined at all.
   */
  static async fromImage(bytes: Uint8Array, options: ImagePageOptions = {}): Promise<PdfDocument> {
    const pdfBytes = await image_to_pdf(bytes, options);
    return PdfDocument.open(pdfBytes);
  }

  getPageCount(): number {
    return this.pageCount;
  }

  /** The current committed baseline - does not reflect pending rotations/deletions. */
  getBytes(): Uint8Array {
    return this.bytes;
  }

  /** Includes a pending *reorder*, not just rotations/deletions - `movePage` alone still changes the output document. */
  hasPendingChanges(): boolean {
    return (
      this.rotations.size > 0 ||
      this.deletions.size > 0 ||
      this.pendingMetadata.size > 0 ||
      this.hasPendingReorder()
    );
  }

  private hasPendingReorder(): boolean {
    return this.order.some((id, index) => id !== index + 1);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Reverts the last state-changing operation - including a `commit()`,
   * `encrypt()` or `decrypt()`, which is why this restores the baseline too
   * (see `DocumentSnapshot`). Synchronous and free: no wasm call, nothing
   * re-rendered, since the preview cache travels with the snapshot.
   *
   * Returns false (and does nothing) when there is nothing to undo.
   */
  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;
    this.redoStack.push(this.snapshot(this.currentLabel));
    this.restore(snapshot);
    return true;
  }

  /** Re-applies the last undone operation. Returns false when there is nothing to redo. */
  redo(): boolean {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return false;
    this.undoStack.push(this.snapshot(this.currentLabel));
    this.restore(snapshot);
    return true;
  }

  /**
   * The whole timeline in chronological order: past states first, then the
   * current one (`current: true`), then the states a `redo()` would move
   * forward into. Index 0 is always the document as it was opened.
   *
   * Meant for a history panel - each entry's `index` is exactly what
   * `goToHistoryIndex()` takes.
   */
  history(): HistoryEntry[] {
    // `redoStack` is a stack: its last element is the state nearest to the
    // present, so it reads backwards compared to the timeline.
    const labels = [
      ...this.undoStack.map((snapshot) => snapshot.label),
      this.currentLabel,
      ...[...this.redoStack].reverse().map((snapshot) => snapshot.label),
    ];
    const currentIndex = this.undoStack.length;
    return labels.map((label, index) => ({ index, label, current: index === currentIndex }));
  }

  /**
   * Jumps to any state in `history()`, backwards or forwards, by replaying
   * `undo()`/`redo()` until it gets there - so it goes through exactly the
   * same code path as stepping there by hand, no separate restore logic to
   * keep in sync. Returns false if the document was already at `index`.
   */
  goToHistoryIndex(index: number): boolean {
    const total = this.undoStack.length + 1 + this.redoStack.length;
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      throw new Error(`passo di cronologia ${index} inesistente (la cronologia ne ha ${total})`);
    }
    let moved = false;
    while (this.undoStack.length > index && this.undo()) moved = true;
    while (this.undoStack.length < index && this.redo()) moved = true;
    return moved;
  }

  /** Drops the undo/redo history, keeping the current state - e.g. to release the baselines it pins. */
  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private snapshot(label: string): DocumentSnapshot {
    return {
      label,
      bytes: this.bytes,
      pageCount: this.pageCount,
      rotations: new Map(this.rotations),
      deletions: new Set(this.deletions),
      order: [...this.order],
      previewCache: new Map(this.previewCache),
      pendingMetadata: new Map(this.pendingMetadata),
      baselineMetadata: this.baselineMetadata,
    };
  }

  /** `rotations`/`deletions`/`previewCache` are `readonly` fields, so they're refilled in place rather than reassigned. */
  private restore(snapshot: DocumentSnapshot): void {
    this.currentLabel = snapshot.label;
    this.bytes = snapshot.bytes;
    this.pageCount = snapshot.pageCount;
    this.order = [...snapshot.order];

    this.rotations.clear();
    for (const [id, degrees] of snapshot.rotations) this.rotations.set(id, degrees);

    this.deletions.clear();
    for (const id of snapshot.deletions) this.deletions.add(id);

    this.previewCache.clear();
    for (const [key, png] of snapshot.previewCache) this.previewCache.set(key, png);

    this.pendingMetadata.clear();
    for (const [field, value] of snapshot.pendingMetadata) this.pendingMetadata.set(field, value);
    this.baselineMetadata = snapshot.baselineMetadata;
  }

  /**
   * Records the current state as an undo step. Called by every mutating
   * method *after* its validation and no-op early-returns, so the history
   * only ever contains steps that actually changed something - an undo
   * always visibly does something.
   */
  private pushUndo(action: string): void {
    this.recordSnapshot(this.snapshot(this.currentLabel), action);
  }

  /** `pushUndo()` for the async operations, which capture their "before" state up front and only commit it to the history once the wasm call has succeeded. */
  private recordSnapshot(snapshot: DocumentSnapshot, action: string): void {
    this.currentLabel = action;
    this.undoStack.push(snapshot);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Pages in their current display order (see `movePage`), not necessarily 1, 2, 3... */
  pages(): PageInfo[] {
    return this.allPageIds().map((id) => this.pageInfo(id));
  }

  /**
   * Moves page `id` to position `toIndex` (0-indexed) in the display order,
   * shifting the pages in between. Nothing is sent to wasm until
   * `commit()`/`exportBytes()` - like rotate/delete, this only updates
   * in-memory bookkeeping (`compose_pdf` already accepts an arbitrary page
   * order, so the reorder is just "free" input to the same commit path).
   */
  movePage(id: PageId, toIndex: number): void {
    this.assertValidPage(id);
    const fromIndex = this.order.indexOf(id);
    const clampedIndex = Math.max(0, Math.min(toIndex, this.order.length - 1));
    if (clampedIndex === fromIndex) return;
    this.pushUndo(`Sposta pagina ${id} in posizione ${clampedIndex + 1}`);
    this.order.splice(fromIndex, 1);
    this.order.splice(clampedIndex, 0, id);
  }

  /**
   * Adds `degrees` (a multiple of 90, positive or negative) to `id`'s
   * pending rotation. Nothing is sent to wasm until `commit()`/`exportBytes()`.
   */
  rotatePage(id: PageId, degrees: number): void {
    this.assertValidPage(id);
    if (degrees % 90 !== 0) {
      throw new Error(`la rotazione deve essere un multiplo di 90, ricevuto ${degrees}`);
    }
    // A multiple of 360 leaves the pending rotation exactly as it was - not
    // a history step.
    if (degrees % 360 === 0) return;
    this.pushUndo(`Ruota pagina ${id} di ${degrees > 0 ? "+" : ""}${degrees}\u00b0`);
    const current = this.rotations.get(id) ?? 0;
    const next = ((current + degrees) % 360 + 360) % 360;
    if (next === 0) this.rotations.delete(id);
    else this.rotations.set(id, next);
  }

  resetRotation(id: PageId): void {
    this.assertValidPage(id);
    if (!this.rotations.has(id)) return;
    this.pushUndo(`Azzera rotazione pagina ${id}`);
    this.rotations.delete(id);
  }

  deletePage(id: PageId): void {
    this.assertValidPage(id);
    if (this.deletions.has(id)) return;
    this.pushUndo(`Elimina pagina ${id}`);
    this.deletions.add(id);
  }

  restorePage(id: PageId): void {
    this.assertValidPage(id);
    if (!this.deletions.has(id)) return;
    this.pushUndo(`Ripristina pagina ${id}`);
    this.deletions.delete(id);
  }

  /**
   * The metadata as it would be after a commit: what the baseline holds, with
   * any pending edits laid over it (a field pending as `null` is reported as
   * absent, since that's what committing it would do).
   *
   * Async and lazy on purpose. `open()` deliberately makes only the one cheap
   * `page_count` call and never renders anything eagerly; reading /Info up
   * front would spend a second wasm round-trip per document on something most
   * sessions never look at. The baseline read is cached afterwards, and that
   * cache is invalidated exactly where `previewCache` is - both depend only
   * on the baseline bytes.
   */
  async getMetadata(): Promise<PdfMetadata> {
    const baseline = await this.ensureBaselineMetadata();

    const metadata: PdfMetadata = { ...baseline };
    for (const [field, value] of this.pendingMetadata) {
      if (value === null) delete metadata[field];
      else metadata[field] = value;
    }
    return metadata;
  }

  /** Which metadata fields currently carry an uncommitted edit - for a UI that wants to mark them. */
  pendingMetadataFields(): Set<MetadataField> {
    return new Set(this.pendingMetadata.keys());
  }

  /** Reads the baseline's /Info once and caches it; every later call is free until the baseline changes. */
  private async ensureBaselineMetadata(): Promise<PdfMetadata> {
    if (!this.baselineMetadata) {
      this.baselineMetadata = (await read_metadata(this.bytes)) as PdfMetadata;
    }
    return this.baselineMetadata;
  }

  /**
   * Queues a metadata edit. Nothing is sent to wasm until `commit()`/
   * `exportBytes()`, like every other page-level edit - which is also what
   * puts it in the undo history for free.
   *
   * Three-state per field: a field left out of `patch` is untouched, a string
   * sets it, `null` deletes the key.
   *
   * Async where `rotatePage`/`deletePage` are sync, for a real reason:
   * deciding whether an edit changes anything at all means knowing what the
   * document already says, and that lives in the PDF. It reads the baseline
   * itself rather than making callers remember to call `getMetadata()` first
   * - after a `commit()` the cached baseline is gone, and that requirement
   * would be a trap.
   */
  async setMetadata(patch: MetadataPatch): Promise<void> {
    const baseline = await this.ensureBaselineMetadata();
    const changed: MetadataField[] = [];
    // Compare against the *effective* value, so re-typing what's already
    // there - or clearing a field that was already absent - isn't an edit.
    for (const field of METADATA_FIELDS) {
      if (!(field in patch)) continue;
      const next = patch[field] ?? null;
      const current = this.pendingMetadata.has(field)
        ? (this.pendingMetadata.get(field) as string | null)
        : (baseline[field] ?? null);
      if (next !== current) changed.push(field);
    }

    if (changed.length === 0) return;

    this.pushUndo(`Modifica metadati (${changed.map((field) => METADATA_LABELS[field]).join(", ")})`);

    for (const field of changed) {
      const next = patch[field] ?? null;
      // An edit that puts a field back to its baseline value is not a
      // pending change any more - drop it rather than writing a redundant
      // key at commit time.
      if ((baseline[field] ?? null) === next) this.pendingMetadata.delete(field);
      else this.pendingMetadata.set(field, next);
    }
  }

  /**
   * Renders `id` as it is in the current baseline (pending edits are not
   * applied - see `PagePreview`'s metadata instead). Cached by (id, scale):
   * calling this again for the same page/scale on an unchanged baseline
   * returns instantly, no wasm call.
   */
  async getPreview(id: PageId, scale = 0.4): Promise<PagePreview> {
    this.assertValidPage(id);
    const key = cacheKey(id, scale);
    let png = this.previewCache.get(key);
    if (!png) {
      png = await render_page_preview(this.bytes, id, scale);
      this.previewCache.set(key, png);
    }
    return { ...this.pageInfo(id), png };
  }

  /**
   * Renders every page (or just `options.range`, for a window of a large
   * document), reusing cached PNGs and only fetching the ones actually
   * missing - e.g. after a `rotatePage`/`deletePage` (which never invalidate
   * the cache, see above) a second call renders nothing new. Spreads
   * whatever *is* missing across a worker pool once there's enough of it to
   * be worth it. `options.onProgress`, if given, fires after each page
   * finishes (in whichever order they complete on the pool path, not
   * necessarily page order).
   */
  async getPreviews(scale = 0.4, options: GetPreviewsOptions = {}): Promise<PagePreview[]> {
    const ids = options.range ? this.pageIdsInRange(options.range) : this.allPageIds();
    const indexOf = new Map(ids.map((id, index) => [id, index]));
    const previews = new Array<PagePreview>(ids.length);
    const missing: PageId[] = [];

    let done = 0;
    const total = ids.length;
    const reportProgress = () => options.onProgress?.(done, total);

    for (const id of ids) {
      const cached = this.previewCache.get(cacheKey(id, scale));
      if (cached) {
        previews[indexOf.get(id) as number] = { ...this.pageInfo(id), png: cached };
        done += 1;
        reportProgress();
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) return previews;

    const store = (page: number, png: Uint8Array) => {
      this.previewCache.set(cacheKey(page, scale), png);
      previews[indexOf.get(page) as number] = { ...this.pageInfo(page), png };
      done += 1;
      reportProgress();
    };

    if (missing.length > PARALLEL_PREVIEW_THRESHOLD) {
      await renderPagesInParallel(this.bytes, missing, scale, store);
    } else {
      for (const id of missing) {
        store(id, await render_page_preview(this.bytes, id, scale));
      }
    }

    return previews;
  }

  /**
   * @internal Used only by `PdfEditor.mergeDocuments()` to transplant already
   * -rendered previews from a source document into the merged result, so a
   * page that's pixel-identical to one already shown doesn't get re-rendered
   * just because it now lives at a different page number in a new document.
   * Not part of the public API - deliberately not a generic/global cache
   * (see docs/development.md for why), just this one targeted transfer.
   */
  cachedEntriesForPage(id: PageId): [scale: number, png: Uint8Array][] {
    const prefix = `${id}:`;
    const entries: [number, Uint8Array][] = [];
    for (const [key, png] of this.previewCache) {
      if (key.startsWith(prefix)) entries.push([Number(key.slice(prefix.length)), png]);
    }
    return entries;
  }

  /** @internal See `cachedEntriesForPage`. */
  primeCache(id: PageId, scale: number, png: Uint8Array): void {
    this.previewCache.set(cacheKey(id, scale), png);
  }

  /** Applies pending rotations/deletions, replacing this document's baseline and clearing pending state. */
  async commit(): Promise<void> {
    if (!this.hasPendingChanges()) return;
    const before = this.snapshot(this.currentLabel);
    this.bytes = await this.computeCommittedBytes();
    this.pageCount = this.order.length - this.deletions.size;
    this.rotations.clear();
    this.deletions.clear();
    this.pendingMetadata.clear();
    this.previewCache.clear();
    this.baselineMetadata = null;
    this.order = identityOrder(this.pageCount);
    // Recorded only once the wasm work has succeeded, so a failed commit
    // leaves no phantom history step. `pushUndo()` would snapshot the
    // *new* state, hence the pre-computed `before`.
    this.recordSnapshot(before, `Conferma modifiche (${this.pageCount} pagine)`);
  }

  /** Same computation as `commit()`, without mutating this document - a preview of the final result. */
  async exportBytes(): Promise<Uint8Array> {
    return this.hasPendingChanges() ? this.computeCommittedBytes() : this.bytes;
  }

  /** Immediate, whole-document operation - no pending state, nothing to preview. */
  async encrypt(ownerPassword: string, userPassword: string): Promise<void> {
    const before = this.snapshot(this.currentLabel);
    this.bytes = await encrypt_pdf(this.bytes, ownerPassword, userPassword);
    this.previewCache.clear();
    this.baselineMetadata = null;
    this.recordSnapshot(before, "Cifra documento");
  }

  /** Immediate, whole-document operation - no pending state, nothing to preview. */
  async decrypt(password: string): Promise<void> {
    const before = this.snapshot(this.currentLabel);
    this.bytes = await decrypt_pdf(this.bytes, password);
    this.pageCount = await page_count(this.bytes);
    this.previewCache.clear();
    this.baselineMetadata = null;
    this.order = identityOrder(this.pageCount);
    this.recordSnapshot(before, "Decifra documento");
  }

  private async computeCommittedBytes(): Promise<Uint8Array> {
    const survivingIds = this.allPageIds().filter((id) => !this.deletions.has(id));
    if (survivingIds.length === 0) {
      throw new Error("il documento risulterebbe vuoto: annulla almeno un'eliminazione prima di confermare");
    }

    let bytes = this.bytes;

    // Skip compose_pdf entirely if nothing actually changed the page
    // sequence - no deletions *and* no reordering (surviving ids still run
    // 1, 2, 3... in order).
    const isUnchangedOrder = survivingIds.every((id, index) => id === index + 1);
    if (!isUnchangedOrder) {
      const layout = survivingIds.map((id) => ({ source: 0, page: id }));
      bytes = await compose_pdf([this.bytes], layout);
    }

    // Rotations are keyed by the *new* position, not the original id: deleting
    // a page shifts every later surviving page's number down.
    const rotations: PendingRotation[] = [];
    survivingIds.forEach((id, index) => {
      const degrees = this.rotations.get(id) ?? 0;
      if (degrees !== 0) rotations.push({ page: index + 1, degrees });
    });

    if (rotations.length > 0) {
      bytes = await rotate_pages(bytes, rotations);
    }

    // Metadata goes last: it has to be written into the document that
    // actually ships, and it never interacts with the page-level steps above
    // (/Info lives in the trailer).
    //
    // `compose_pdf` builds a brand new document and only carries /Root over,
    // so a plain delete or reorder would otherwise silently drop the
    // document's title and author. When the page sequence changed, the whole
    // baseline is re-written on top of the pending edits, not just the edits.
    const rewritesDocument = !isUnchangedOrder;
    if (this.pendingMetadata.size > 0 || rewritesDocument) {
      const patch: Record<string, string | null> = {};
      if (rewritesDocument) {
        const baseline = this.baselineMetadata ?? ((await read_metadata(this.bytes)) as PdfMetadata);
        this.baselineMetadata = baseline;
        for (const field of METADATA_FIELDS) {
          const value = baseline[field];
          if (value !== undefined) patch[field] = value;
        }
      }
      for (const [field, value] of this.pendingMetadata) patch[field] = value;

      if (Object.keys(patch).length > 0) bytes = await write_metadata(bytes, patch);
    }

    return bytes;
  }

  private pageInfo(id: PageId): PageInfo {
    return {
      id,
      pendingRotation: this.rotations.get(id) ?? 0,
      markedForDeletion: this.deletions.has(id),
    };
  }

  private allPageIds(): PageId[] {
    return [...this.order];
  }

  /** `range` is a 1-indexed, inclusive window over the current *display order* (positions, not original page ids). */
  private pageIdsInRange(range: PageRange): PageId[] {
    this.assertValidPage(range.start);
    this.assertValidPage(range.end);
    if (range.start > range.end) {
      throw new Error(`range non valido: start (${range.start}) è maggiore di end (${range.end})`);
    }
    return this.order.slice(range.start - 1, range.end);
  }

  private assertValidPage(id: PageId): void {
    if (!Number.isInteger(id) || id < 1 || id > this.pageCount) {
      throw new Error(`pagina ${id} inesistente (il documento ne ha ${this.pageCount})`);
    }
  }
}
