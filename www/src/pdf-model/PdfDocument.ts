import {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  image_to_pdf,
  page_count,
  render_page_preview,
  rotate_pages,
} from "../pdfrs-worker-client";
import { renderPagesInParallel } from "../preview-worker-pool";
import type { HistoryEntry, ImagePageOptions, PageId, PageInfo, PagePreview, PageRange } from "./types";

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
}

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
    return this.rotations.size > 0 || this.deletions.size > 0 || this.hasPendingReorder();
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
    this.previewCache.clear();
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
    this.recordSnapshot(before, "Cifra documento");
  }

  /** Immediate, whole-document operation - no pending state, nothing to preview. */
  async decrypt(password: string): Promise<void> {
    const before = this.snapshot(this.currentLabel);
    this.bytes = await decrypt_pdf(this.bytes, password);
    this.pageCount = await page_count(this.bytes);
    this.previewCache.clear();
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
