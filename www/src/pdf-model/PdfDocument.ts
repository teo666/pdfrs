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
import type { ImagePageOptions, PageId, PageInfo, PagePreview, PageRange } from "./types";

export interface GetPreviewsOptions {
  /** 1-indexed, inclusive window over the current *display order* (positions, not original page ids). Defaults to the whole document - set it to render only a window of a large document. */
  range?: PageRange;
  /** Fires after each page finishes (cache hits count as instantly "done" too), so callers can show real progress. */
  onProgress?: (done: number, total: number) => void;
}

/** Above this many pages, getPreviews() spreads rendering across a worker pool instead of the single shared worker. */
const PARALLEL_PREVIEW_THRESHOLD = 6;

interface PendingRotation {
  page: number;
  degrees: number;
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

  hasPendingChanges(): boolean {
    return this.rotations.size > 0 || this.deletions.size > 0;
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
    const current = this.rotations.get(id) ?? 0;
    const next = ((current + degrees) % 360 + 360) % 360;
    if (next === 0) this.rotations.delete(id);
    else this.rotations.set(id, next);
  }

  resetRotation(id: PageId): void {
    this.assertValidPage(id);
    this.rotations.delete(id);
  }

  deletePage(id: PageId): void {
    this.assertValidPage(id);
    this.deletions.add(id);
  }

  restorePage(id: PageId): void {
    this.assertValidPage(id);
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
    this.bytes = await this.computeCommittedBytes();
    this.pageCount = this.order.length - this.deletions.size;
    this.rotations.clear();
    this.deletions.clear();
    this.previewCache.clear();
    this.order = identityOrder(this.pageCount);
  }

  /** Same computation as `commit()`, without mutating this document - a preview of the final result. */
  async exportBytes(): Promise<Uint8Array> {
    return this.hasPendingChanges() ? this.computeCommittedBytes() : this.bytes;
  }

  /** Immediate, whole-document operation - no pending state, nothing to preview. */
  async encrypt(ownerPassword: string, userPassword: string): Promise<void> {
    this.bytes = await encrypt_pdf(this.bytes, ownerPassword, userPassword);
    this.previewCache.clear();
  }

  /** Immediate, whole-document operation - no pending state, nothing to preview. */
  async decrypt(password: string): Promise<void> {
    this.bytes = await decrypt_pdf(this.bytes, password);
    this.pageCount = await page_count(this.bytes);
    this.previewCache.clear();
    this.order = identityOrder(this.pageCount);
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
