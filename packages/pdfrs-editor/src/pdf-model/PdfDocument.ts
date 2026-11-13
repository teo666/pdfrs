import {
  annotate_pdf,
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  extract_image,
  image_to_pdf,
  is_password_protected,
  list_images,
  merge_pdfs,
  page_count,
  read_metadata,
  read_outline,
  remove_images,
  rotate_pages,
  write_metadata,
  write_outline,
} from "../worker/pdfrs-worker-client";
import { renderPageOnPool, renderPagesInParallel } from "../worker/preview-worker-pool";
import type { TextContent } from "../text/layout";
import type {
  AnnotationId,
  AssetId,
  ExtractedImage,
  HistoryEntry,
  ImageAsset,
  PageAnnotation,
  ImagePageOptions,
  MetadataField,
  MetadataPatch,
  OutlineEntry,
  PageId,
  PageInfo,
  PagePreview,
  PageRange,
  PdfImages,
  PdfMetadata,
} from "./types";

export interface GetPreviewsOptions {
  /** 1-indexed, inclusive window over the current *display order* (positions, not original page ids). Defaults to the whole document - set it to render only a window of a large document. */
  range?: PageRange;
  /** Fires after each page finishes (cache hits count as instantly "done" too), so callers can show real progress. */
  onProgress?: (done: number, total: number) => void;
  /** Fires with each page's preview as soon as it's available (cache hits first, then renders in completion order), so a UI can show thumbnails progressively instead of waiting for the whole batch. */
  onPreview?: (preview: PagePreview) => void;
}

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
  annotations: Map<AnnotationId, PageAnnotation>;
  removedImages: Set<string>;
  baselineImages: PdfImages | null;
  photos: Map<PageId, PhotoSource>;
  appliedPageCount: number;
  replacedFrom: Map<PageId, PageId>;
  baselineOutline: OutlineEntry[] | null;
}

/** The JPEG a page was made from, and the page it was put on: kept so the page can be made again on another one. */
export interface PhotoSource {
  jpeg: Uint8Array;
  options: ImagePageOptions;
}

const samePageOptions = (a: ImagePageOptions, b: ImagePageOptions) =>
  (a.pageSize ?? "native") === (b.pageSize ?? "native") &&
  (a.orientation ?? "auto") === (b.orientation ?? "auto") &&
  (a.margin ?? 0) === (b.margin ?? 0);

/**
 * Outline entries with their pages renumbered by `pages` (old → new). An
 * entry whose page isn't in the map goes, and its children move up a level
 * into its place; one that points nowhere stays as it is.
 */
export function remapOutline(entries: OutlineEntry[], pages: Map<PageId, number>): OutlineEntry[] {
  const result: OutlineEntry[] = [];
  // Levels of the entries dropped above the current one.
  const dropped: number[] = [];
  for (const entry of entries) {
    while (dropped.length > 0 && dropped[dropped.length - 1]! >= entry.level) dropped.pop();
    const page = entry.page ?? null;
    if (page !== null && !pages.has(page)) {
      dropped.push(entry.level);
      continue;
    }
    result.push({
      ...entry,
      level: Math.max(1, entry.level - dropped.length),
      page: page === null ? null : pages.get(page)!,
    });
  }
  return result;
}

const PAGE_NAMES: Record<NonNullable<ImagePageOptions["pageSize"]>, string> = {
  a4: "su A4",
  letter: "su Letter",
  native: "a dimensione reale",
};

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

function assertText(text: TextContent): void {
  if (!text.text.trim()) throw new Error("il testo è vuoto");
  if (!["helvetica", "times", "courier"].includes(text.font)) throw new Error(`font sconosciuto: ${text.font}`);
}

function assertBox(box: { x: number; y: number; width: number; rotation: number; height?: number | null }): void {
  const heightOk = box.height == null || (Number.isFinite(box.height) && box.height > 0);
  if (![box.x, box.y, box.width, box.rotation].every(Number.isFinite) || box.width <= 0 || !heightOk) {
    throw new Error(`posizione non valida: x=${box.x}, y=${box.y}, larghezza=${box.width}, rotazione=${box.rotation}`);
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** An angle in degrees brought into (-180, 180], so equal turns compare equal. */
function normalizeAngle(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  return turned > 180 ? turned - 360 : turned;
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
  // Images placed on pages and not applied yet (see PageAnnotation), part of
  // the undoable state. The images themselves live in `assets`, which only
  // ever grows: an asset is immutable, so snapshots can share it, and one no
  // annotation refers to is simply never written into the file.
  private readonly annotationsById = new Map<AnnotationId, PageAnnotation>();
  private readonly assets = new Map<AssetId, ImageAsset>();
  private readonly assetNouns = new Map<AssetId, string>();
  private nextAssetId = 1;
  // Not restored by undo, so an id is never handed out twice.
  private nextAnnotationId = 1;
  private nextGroupId = 1;
  // What the baseline's /Info holds, read lazily on the first getMetadata()
  // call and cached like the previews are - `null` means "not read yet".
  // Invalidated wherever `previewCache` is, since it depends on exactly the
  // same thing: the baseline bytes.
  private baselineMetadata: PdfMetadata | null = null;
  // The images the baseline holds and where they're drawn: read lazily and
  // cached like the metadata (`null` = not read yet), invalidated wherever
  // the baseline bytes change.
  private baselineImages: PdfImages | null = null;
  // The baseline's outline, its pages as page ids: read lazily and cached
  // like the metadata (`null` = not read yet). Page operations that rebuild
  // the file (compose, merge) drop the outline; it's written back from this.
  private baselineOutline: OutlineEntry[] | null = null;
  // Image draws to take away (placement ids from `getImages`), not applied
  // yet: part of the undoable state, like the annotations.
  private readonly removedImages = new Set<string>();
  // Pages made from a JPEG (opened as one, or inserted), with the photo and
  // the page it's on, so `setPhotoPage` can put it on another. Part of the
  // undoable state. Dropped for a page once it's changed in a way a new
  // page couldn't carry (see `commit`).
  private readonly photos = new Map<PageId, PhotoSource>();
  // How many pages the document had when last applied (or opened): ids up
  // to it are the pages it had then, numbered as they were (see
  // `PageInfo.originalNumber`); ids past it were added since.
  private appliedPageCount: number;
  // A photo page put on another page (`setPhotoPage`) → the page it replaced.
  private readonly replacedFrom = new Map<PageId, PageId>();
  private undoStack: DocumentSnapshot[] = [];
  private redoStack: DocumentSnapshot[] = [];
  // Describes how the *current* state was reached; moves onto a snapshot as
  // soon as that state becomes a past (or future) one.
  private currentLabel = "Documento aperto";

  /** Can't be read without a password: no pages until decrypted (see `isLocked`). */
  private readonly locked: boolean;

  private constructor(bytes: Uint8Array, pageCount: number, locked = false) {
    this.bytes = bytes;
    this.pageCount = pageCount;
    this.locked = locked;
    this.appliedPageCount = pageCount;
    this.order = identityOrder(pageCount);
  }

  /**
   * Opens a PDF. Only calls the cheap `page_count` - never renders a
   * preview eagerly, that stays behind an explicit `getPreview`/`getPreviews`
   * call.
   */
  static async open(bytes: Uint8Array): Promise<PdfDocument> {
    const count = await page_count(bytes);
    // A PDF that needs a password reads as having no pages: asked only
    // then, so an ordinary PDF isn't parsed twice.
    const locked = count === 0 && (await is_password_protected(bytes));
    return new PdfDocument(bytes, count, locked);
  }

  /**
   * True for a PDF that can't be read without its password: it has no pages
   * here, and its bytes (`getBytes`/`exportBytes`) are the encrypted file,
   * as it was opened. `PdfEditor.unlockDocument` makes a readable copy.
   */
  isLocked(): boolean {
    return this.locked;
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
    const doc = await PdfDocument.open(pdfBytes);
    doc.photos.set(1, { jpeg: bytes, options: { ...options } });
    return doc;
  }

  // --- Pages made from a photo ---------------------------------------------

  /** The pages made from a JPEG, with the page options each is on now. */
  photoPages(): Map<PageId, ImagePageOptions> {
    return new Map([...this.photos].map(([page, photo]) => [page, { ...photo.options }]));
  }

  /** @internal What a page was made from, for `PdfEditor` to carry it into another document. */
  photoSource(page: PageId): PhotoSource | undefined {
    return this.photos.get(page);
  }

  /** @internal See `photoSource`: the page `page` here is that photo, as it is. */
  adoptPhoto(page: PageId, photo: PhotoSource): void {
    this.photos.set(page, photo);
  }

  /** Adds a page made from a JPEG (see `insertPages`), remembering the photo so its page can be changed later. */
  async insertImage(jpeg: Uint8Array, options: ImagePageOptions = {}, at?: number): Promise<PageId> {
    const pdf = await image_to_pdf(jpeg, options);
    const [page] = await this.insertPages(pdf, at, "Inserisci foto");
    if (page === undefined) throw new Error("la foto non ha prodotto alcuna pagina");
    this.photos.set(page, { jpeg, options: { ...options } });
    return page;
  }

  /**
   * Puts the photo page `page` on another page - A4, Letter, or the photo's
   * own size - by making it again from its JPEG. The new page takes the old
   * one's place in the order, and its pending rotation, deletion and
   * annotations; it has a new id, which is returned (the same id when
   * nothing changes). One undo step.
   */
  async setPhotoPage(page: PageId, options: ImagePageOptions): Promise<PageId> {
    const photo = this.photos.get(page);
    if (!photo) throw new Error(`la pagina ${page} non è una foto`);
    const position = this.order.indexOf(page);
    if (position === -1) throw new Error(`pagina ${page} inesistente`);
    if (samePageOptions(photo.options, options)) return page;

    const before = this.snapshot(this.currentLabel);
    const pdf = await image_to_pdf(photo.jpeg, options);
    // As in insertPages: merging keeps only /Root, so /Info is written back.
    const metadata = await this.ensureBaselineMetadata();
    let merged = await merge_pdfs([this.bytes, pdf]);
    if (Object.keys(metadata).length > 0) merged = await write_metadata(merged, { ...metadata });
    const replacement = this.pageCount + 1;
    // Merging drops the outline: written back, entries for the old page now on the new one.
    const outline = (await this.ensureBaselineOutline()).map((entry) =>
      entry.page === page ? { ...entry, page: replacement } : entry,
    );
    if (outline.length > 0) merged = await write_outline(merged, outline);
    const removals = this.removedImages.size > 0 ? await this.remapRemovals(merged) : null;

    this.bytes = merged;
    this.pageCount += 1;
    this.baselineImages = null;
    this.baselineOutline = outline;
    // The old page stays in the baseline, out of the order: the next commit drops it.
    this.order[position] = replacement;
    const rotation = this.rotations.get(page);
    if (rotation !== undefined) {
      this.rotations.delete(page);
      this.rotations.set(replacement, rotation);
    }
    if (this.deletions.delete(page)) this.deletions.add(replacement);
    for (const [id, annotation] of this.annotationsById) {
      if (annotation.page === page) this.annotationsById.set(id, { ...annotation, page: replacement });
    }
    if (removals) {
      this.removedImages.clear();
      // Removals on the old page went with it: the new one is a fresh picture.
      for (const id of removals) if (!id.startsWith(`p${page}#`)) this.removedImages.add(id);
    }
    this.photos.delete(page);
    this.photos.set(replacement, { jpeg: photo.jpeg, options: { ...options } });
    this.replacedFrom.set(replacement, page);
    this.recordSnapshot(before, `Foto ${PAGE_NAMES[options.pageSize ?? "native"]} (pagina ${position + 1})`);
    return replacement;
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
      this.annotationsById.size > 0 ||
      this.removedImages.size > 0 ||
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
      annotations: new Map(this.annotationsById),
      removedImages: new Set(this.removedImages),
      baselineImages: this.baselineImages,
      photos: new Map(this.photos),
      appliedPageCount: this.appliedPageCount,
      replacedFrom: new Map(this.replacedFrom),
      baselineOutline: this.baselineOutline,
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

    this.annotationsById.clear();
    for (const [id, annotation] of snapshot.annotations) this.annotationsById.set(id, annotation);

    this.removedImages.clear();
    for (const id of snapshot.removedImages) this.removedImages.add(id);
    this.baselineImages = snapshot.baselineImages;

    this.photos.clear();
    for (const [page, photo] of snapshot.photos) this.photos.set(page, photo);
    this.appliedPageCount = snapshot.appliedPageCount;
    this.baselineOutline = snapshot.baselineOutline;
    this.replacedFrom.clear();
    for (const [page, old] of snapshot.replacedFrom) this.replacedFrom.set(page, old);
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
   * Group versions of the page edits above, for a multi-page selection: each
   * call is *one* undo step whatever the number of pages ("Ruota 12 pagine"),
   * not one per page. With a single page they behave exactly like the
   * single-page method (same history label). Duplicate ids are ignored.
   */
  rotatePages(ids: PageId[], degrees: number): void {
    const targets = this.distinctPages(ids);
    if (degrees % 90 !== 0) {
      throw new Error(`la rotazione deve essere un multiplo di 90, ricevuto ${degrees}`);
    }
    if (targets.length === 1) return this.rotatePage(targets[0] as PageId, degrees);
    if (targets.length === 0 || degrees % 360 === 0) return;
    this.pushUndo(`Ruota ${targets.length} pagine di ${degrees > 0 ? "+" : ""}${degrees}\u00b0`);
    for (const id of targets) {
      const next = (((this.rotations.get(id) ?? 0) + degrees) % 360 + 360) % 360;
      if (next === 0) this.rotations.delete(id);
      else this.rotations.set(id, next);
    }
  }

  /** See `rotatePages`. Pages already marked are skipped; nothing left to mark means no history step. */
  deletePages(ids: PageId[]): void {
    const targets = this.distinctPages(ids).filter((id) => !this.deletions.has(id));
    if (targets.length === 1) return this.deletePage(targets[0] as PageId);
    if (targets.length === 0) return;
    this.pushUndo(`Elimina ${targets.length} pagine`);
    for (const id of targets) this.deletions.add(id);
  }

  /** See `rotatePages`. Pages not marked for deletion are skipped. */
  restorePages(ids: PageId[]): void {
    const targets = this.distinctPages(ids).filter((id) => this.deletions.has(id));
    if (targets.length === 1) return this.restorePage(targets[0] as PageId);
    if (targets.length === 0) return;
    this.pushUndo(`Ripristina ${targets.length} pagine`);
    for (const id of targets) this.deletions.delete(id);
  }

  /**
   * Moves several pages as one block: they keep their relative display
   * order and land together at `toIndex`, an index into the order *without*
   * them (0 = in front of everything, the number of other pages = at the
   * end; clamped). The pages don't need to be contiguous beforehand.
   */
  movePages(ids: PageId[], toIndex: number): void {
    const moving = new Set(this.distinctPages(ids));
    if (moving.size === 0) return;
    const block = this.order.filter((id) => moving.has(id));
    const rest = this.order.filter((id) => !moving.has(id));
    const at = Math.max(0, Math.min(toIndex, rest.length));
    if (block.length === 1) return this.movePage(block[0] as PageId, at);
    const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    if (next.every((id, index) => id === this.order[index])) return;
    this.pushUndo(`Sposta ${block.length} pagine in posizione ${at + 1}`);
    this.order = next;
  }

  /**
   * Adds the pages of another PDF to this document, placed at `at` in the
   * display order (0 = in front, default: at the end). They join the
   * baseline - like a commit, it's one undo step that undo puts back
   * exactly - while the pending edits on the existing pages are kept: those
   * pages keep their ids, and so do their cached previews. The new pages get
   * the ids after the last one. Returns those ids, in order.
   */
  async insertPages(bytes: Uint8Array, at?: number, label?: string): Promise<PageId[]> {
    const before = this.snapshot(this.currentLabel);
    const added = await page_count(bytes);
    if (added === 0) return [];
    // merge_pdfs only carries /Root over: the document's own /Info would be
    // lost, so it's written back onto the merged result.
    const metadata = await this.ensureBaselineMetadata();
    let merged = await merge_pdfs([this.bytes, bytes]);
    if (Object.keys(metadata).length > 0) merged = await write_metadata(merged, { ...metadata });
    // So is the outline: the existing pages keep their numbers, so it goes back as it was.
    const outline = await this.ensureBaselineOutline();
    if (outline.length > 0) merged = await write_outline(merged, outline);

    // Merging renumbers the objects, so a pending removal inside a Form
    // (whose id names the Form's object) is carried over to its new id.
    const removals = this.removedImages.size > 0 ? await this.remapRemovals(merged) : null;

    const ids = Array.from({ length: added }, (_, index) => this.pageCount + index + 1);
    const index = Math.max(0, Math.min(at ?? this.order.length, this.order.length));
    this.bytes = merged;
    this.baselineImages = null;
    if (removals) {
      this.removedImages.clear();
      for (const id of removals) this.removedImages.add(id);
    }
    this.pageCount += added;
    this.order.splice(index, 0, ...ids);
    this.recordSnapshot(before, label ?? `Inserisci ${added === 1 ? "1 pagina" : `${added} pagine`}`);
    return ids;
  }

  /**
   * A new PDF made of just these pages, in the order given, each with its
   * pending rotation and annotations applied - what "extract these pages"
   * should produce.
   * Pending deletions and the document's metadata are not involved, and this
   * document is left untouched.
   */
  async exportPages(ids: PageId[]): Promise<Uint8Array> {
    const pages = this.distinctPages(ids);
    if (pages.length === 0) throw new Error("nessuna pagina da esportare");
    let bytes = await compose_pdf(
      [await this.editedBaseline(new Set(pages))],
      pages.map((id) => ({ source: 0, page: id })),
    );
    // The outline entries of the pages exported, pointing at their new numbers.
    const outline = remapOutline(
      await this.ensureBaselineOutline(),
      new Map(pages.map((id, index) => [id, index + 1])),
    );
    if (outline.length > 0) bytes = await write_outline(bytes, outline);
    const rotations: PendingRotation[] = [];
    pages.forEach((id, index) => {
      const degrees = this.rotations.get(id) ?? 0;
      if (degrees !== 0) rotations.push({ page: index + 1, degrees });
    });
    if (rotations.length > 0) bytes = await rotate_pages(bytes, rotations);
    return bytes;
  }

  // --- Annotations: images placed on pages ----------------------------------

  /** Registers an image for `addAnnotation`. The pixels are kept as they are: don't mutate them afterwards. */
  /**
   * Registers an image for `addAnnotation`. `noun` is how the history names
   * what's placed with it ("Aggiungi immagine a pagina 2"): an Italian noun
   * without article, "firma" by default. The pixels are kept as they are: don't
   * mutate them afterwards.
   */
  addAsset(asset: ImageAsset, noun = "firma"): AssetId {
    if (
      !Number.isInteger(asset.width) ||
      !Number.isInteger(asset.height) ||
      asset.width <= 0 ||
      asset.height <= 0 ||
      asset.pixels.length !== asset.width * asset.height * 4
    ) {
      throw new Error(`immagine non valida: ${asset.width}x${asset.height} con ${asset.pixels.length} byte`);
    }
    const id = this.nextAssetId++;
    this.assets.set(id, asset);
    this.assetNouns.set(id, noun);
    return id;
  }

  /** What the history calls an annotation: "testo", or its image's noun. */
  private nounOf(annotation: PageAnnotation): string {
    if (annotation.text) return "testo";
    return (annotation.asset !== null && this.assetNouns.get(annotation.asset)) || "firma";
  }

  /** The pending annotations, in the order they were added. */
  annotations(): PageAnnotation[] {
    return [...this.annotationsById.values()].map((annotation) => ({ ...annotation }));
  }

  /** Pages carrying at least one pending annotation. */
  pagesWithAnnotations(): Set<PageId> {
    return new Set([...this.annotationsById.values()].map((annotation) => annotation.page));
  }

  /** Places an image on a page, as a pending edit (one undo step). `rotation` defaults to 0. */
  addAnnotation(
    annotation: Omit<PageAnnotation, "id" | "rotation" | "height" | "group" | "linked" | "text" | "asset"> & {
      asset: AssetId;
      rotation?: number;
      height?: number | null;
    },
  ): AnnotationId {
    if (!this.assets.has(annotation.asset)) throw new Error(`immagine ${annotation.asset} non registrata`);
    return this.place({ ...annotation, text: null });
  }

  /**
   * Places real text on a page, as a pending edit (one undo step). Its box
   * works like an image's: `width` decides how big the text comes out (the
   * height follows from the laid out text unless `height` stretches it).
   */
  addTextAnnotation(
    annotation: Omit<PageAnnotation, "id" | "rotation" | "height" | "group" | "linked" | "asset" | "text"> & {
      text: TextContent;
      rotation?: number;
      height?: number | null;
    },
  ): AnnotationId {
    assertText(annotation.text);
    return this.place({ ...annotation, text: { ...annotation.text }, asset: null });
  }

  private place(
    annotation: Omit<PageAnnotation, "id" | "rotation" | "height" | "group" | "linked"> & {
      rotation?: number;
      height?: number | null;
    },
  ): AnnotationId {
    this.assertValidPage(annotation.page);
    const placed: Omit<PageAnnotation, "id"> = {
      ...annotation,
      rotation: normalizeAngle(annotation.rotation ?? 0),
      height: annotation.height ?? null,
      group: null,
      linked: false,
    };
    assertBox(placed);
    const id = this.nextAnnotationId++;
    this.pushUndo(`Aggiungi ${this.nounOf({ ...placed, id })} a pagina ${annotation.page}`);
    this.annotationsById.set(id, { ...placed, id });
    return id;
  }

  /**
   * Puts the same annotation on every page of the document (one undo step):
   * linked copies with the same image, position, size and angle - editing
   * any of them edits them all. Pages that already have a copy of the group
   * (linked or not) are skipped, so applying again only fills in pages added
   * since. On a copy that was unlinked, this links it back: it takes the
   * group's current position again. Returns the ids of the new copies.
   */
  applyAnnotationToAllPages(id: AnnotationId): AnnotationId[] {
    const source = this.annotationsById.get(id);
    if (!source) throw new Error(`firma ${id} inesistente`);
    const group = source.group ?? this.nextGroupId++;
    const inGroup = [...this.annotationsById.values()].filter((a) => a.group === group);
    const covered = new Set([...inGroup.map((a) => a.page), source.page]);
    const targets = this.order.filter((page) => !covered.has(page));
    const relinking = source.group !== null && !source.linked;
    if (targets.length === 0 && !relinking) return [];

    // Linking back takes the box the linked copies have now, if any are left.
    const reference = inGroup.find((a) => a.linked && a.id !== id) ?? source;
    const { x, y, width, rotation, height } = reference;
    this.pushUndo(
      relinking
        ? `${capitalize(this.nounOf(source))} di nuovo come le altre copie a pagina ${source.page}`
        : `${capitalize(this.nounOf(source))} su tutte le pagine (${covered.size + targets.length})`,
    );
    const linked = { ...source, x, y, width, rotation, height, group, linked: true };
    this.annotationsById.set(id, linked);
    return targets.map((page) => {
      const copyId = this.nextAnnotationId++;
      this.annotationsById.set(copyId, { ...linked, id: copyId, page });
      return copyId;
    });
  }

  /**
   * Unlinks one copy from its group (one undo step): it keeps its place and
   * from now on is edited on its own; the other copies stay linked.
   */
  detachAnnotation(id: AnnotationId): void {
    const current = this.annotationsById.get(id);
    if (!current || !current.linked) return;
    this.pushUndo(`${capitalize(this.nounOf(current))} modificabile solo a pagina ${current.page}`);
    this.annotationsById.set(id, { ...current, linked: false });
  }

  /** The copies that move with `annotation`: its linked group, or just itself. */
  private groupMembers(annotation: PageAnnotation): PageAnnotation[] {
    if (annotation.group === null || !annotation.linked) return [annotation];
    return [...this.annotationsById.values()].filter((a) => a.group === annotation.group && a.linked);
  }

  /**
   * Moves, resizes and/or turns an annotation - and, if it's a linked copy,
   * all the linked copies alike (one undo step; nothing if nothing changes).
   */
  updateAnnotation(
    id: AnnotationId,
    patch: Partial<Pick<PageAnnotation, "x" | "y" | "width" | "rotation" | "height" | "text">>,
  ): void {
    const current = this.annotationsById.get(id);
    if (!current) throw new Error(`firma ${id} inesistente`);
    if (patch.text !== undefined && current.text === null) throw new Error("solo un testo può cambiare testo");
    const next = { ...current, ...patch };
    if (patch.text) next.text = { ...patch.text };
    next.rotation = normalizeAngle(next.rotation);
    assertBox(next);
    if (next.text) assertText(next.text);
    const textChanged = JSON.stringify(next.text) !== JSON.stringify(current.text);
    if (
      next.x === current.x &&
      next.y === current.y &&
      next.width === current.width &&
      next.rotation === current.rotation &&
      next.height === current.height &&
      !textChanged
    ) {
      return;
    }
    const verb = textChanged
      ? "Modifica"
      : next.rotation !== current.rotation
        ? "Ruota"
        : next.width !== current.width || next.height !== current.height
          ? "Ridimensiona"
          : "Sposta";
    const members = this.groupMembers(current);
    this.pushUndo(
      members.length > 1
        ? `${verb} ${this.nounOf(current)} su ${members.length} pagine`
        : `${verb} ${this.nounOf(current)} a pagina ${current.page}`,
    );
    const { x, y, width, rotation, height, text } = next;
    for (const member of members) {
      this.annotationsById.set(member.id, { ...member, x, y, width, rotation, height, text });
    }
  }

  /** Removes an annotation - with all its linked copies, if it's one (one undo step). */
  removeAnnotation(id: AnnotationId): void {
    const current = this.annotationsById.get(id);
    if (!current) return;
    const members = this.groupMembers(current);
    this.pushUndo(
      members.length > 1
        ? `Rimuovi ${this.nounOf(current)} da ${members.length} pagine`
        : `Rimuovi ${this.nounOf(current)} da pagina ${current.page}`,
    );
    for (const member of members) this.annotationsById.delete(member.id);
  }

  /**
   * The baseline with the pending annotations drawn in (only those on
   * `pages`, if given). Without any, the baseline itself - no wasm call.
   */
  /**
   * The baseline with the pending edits that refer to its own page ids and
   * coordinates applied: image removals first, then annotations (`pages`
   * limits the annotations to those pages; removals elsewhere change
   * nothing the caller keeps).
   */
  private async editedBaseline(pages?: Set<PageId>): Promise<Uint8Array> {
    let bytes = this.bytes;
    if (this.removedImages.size > 0) bytes = await remove_images(bytes, [...this.removedImages]);
    return this.annotatedBaseline(bytes, pages);
  }

  // --- Images already in the PDF -------------------------------------------

  /**
   * The images the document holds and every place one is drawn, as the
   * baseline has them (pending removals are not taken out: see
   * `pendingImageRemovals`). Read the first time it's asked for and cached
   * until the baseline changes, like `getMetadata`.
   */
  async getImages(): Promise<PdfImages> {
    if (!this.baselineImages) this.baselineImages = await list_images(this.bytes);
    // A page replaced by `setPhotoPage` is still in the baseline, but not in the document.
    const shown = new Set(this.order);
    const placements = this.baselineImages.placements.filter((placement) => shown.has(placement.page));
    const drawn = new Set(placements.map((placement) => placement.image));
    return { images: this.baselineImages.images.filter((image) => drawn.has(image.key)), placements };
  }

  /** The placement ids waiting to be removed. */
  pendingImageRemovals(): Set<string> {
    return new Set(this.removedImages);
  }

  /** Pages a pending removal touches (a Form's on every page that draws it). */
  pagesWithImageRemovals(): Set<PageId> {
    const pages = new Set<PageId>();
    for (const placement of this.baselineImages?.placements ?? []) {
      if (this.removedImages.has(placement.id)) pages.add(placement.page);
    }
    return pages;
  }

  /**
   * Takes away the images drawn at `ids` (placement ids from `getImages`),
   * as a pending edit: one undo step, applied by `commit()`/`exportBytes()`.
   * An image nothing draws any more after that leaves the file.
   */
  removeImages(ids: string[]): void {
    const fresh = [...new Set(ids)].filter((id) => !this.removedImages.has(id));
    if (fresh.length === 0) return;
    this.pushUndo(this.removalLabel("Rimuovi", fresh));
    for (const id of fresh) this.removedImages.add(id);
  }

  /** Puts back images `removeImages` took away (one undo step). */
  restoreImages(ids: string[]): void {
    const removed = [...new Set(ids)].filter((id) => this.removedImages.has(id));
    if (removed.length === 0) return;
    this.pushUndo(this.removalLabel("Ripristina", removed));
    for (const id of removed) this.removedImages.delete(id);
  }

  /** "Rimuovi immagine (pagina 3)", "Rimuovi 2 immagini da 12 pagine"... */
  private removalLabel(verb: string, ids: string[]): string {
    const wanted = new Set(ids);
    const pages = new Set(
      (this.baselineImages?.placements ?? []).filter((p) => wanted.has(p.id)).map((p) => p.page),
    );
    const what = ids.length === 1 ? "immagine" : `${ids.length} immagini`;
    if (pages.size === 1) return `${verb} ${what} (pagina ${[...pages][0]})`;
    if (pages.size > 1) return `${verb} ${what} da ${pages.size} pagine`;
    return `${verb} ${what}`;
  }

  /**
   * An image of the baseline as a file of its own: the JPEG as stored when
   * it can be, otherwise a PNG. `maxSize` caps the longer side, for
   * thumbnails.
   */
  async extractImage(key: string, maxSize?: number): Promise<ExtractedImage> {
    return extract_image(this.bytes, key, maxSize);
  }

  /**
   * The pending removals' ids as they'll be in `next` - the same pages, with
   * more appended, after `merge_pdfs` renumbered every object. A page's own
   * draws keep their id; a Form's draw is found again by its page and its
   * place among that page's draws, which merging doesn't change.
   */
  private async remapRemovals(next: Uint8Array): Promise<string[]> {
    const before = (await this.getImages()).placements;
    const after = (await list_images(next)).placements;
    const byPage = (placements: PdfImages["placements"]) => {
      const pages = new Map<PageId, string[]>();
      for (const p of placements) pages.set(p.page, [...(pages.get(p.page) ?? []), p.id]);
      return pages;
    };
    const oldPages = byPage(before);
    const newPages = byPage(after);
    const remapped = new Set<string>();
    for (const id of this.removedImages) {
      for (const [page, ids] of oldPages) {
        const index = ids.indexOf(id);
        const moved = index === -1 ? undefined : newPages.get(page)?.[index];
        if (moved) {
          remapped.add(moved);
          break;
        }
      }
    }
    return [...remapped];
  }

  private async annotatedBaseline(base: Uint8Array, pages?: Set<PageId>): Promise<Uint8Array> {
    const annotations = [...this.annotationsById.values()].filter(
      (annotation) => !pages || pages.has(annotation.page),
    );
    if (annotations.length === 0) return base;

    // Each asset once, however many annotations use it.
    const used = [...new Set(annotations.flatMap((annotation) => (annotation.asset === null ? [] : [annotation.asset])))];
    const index = new Map(used.map((asset, position) => [asset, position]));
    const images = used.map((asset) => this.assets.get(asset) as ImageAsset);
    return annotate_pdf(
      base,
      images.map((image) => image.pixels),
      images.map(({ width, height }) => ({ width, height })),
      annotations.map(({ page, x, y, width, rotation, height, asset, text }) => ({
        page,
        x,
        y,
        width,
        rotation,
        ...(height === null ? {} : { height }),
        ...(text ? { kind: "text" as const, ...text } : { kind: "image" as const, asset: index.get(asset as AssetId) as number }),
      })),
    );
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
  // --- Outline ---------------------------------------------------------------

  /** Reads the baseline's outline once; every later call is free until the baseline changes. */
  private async ensureBaselineOutline(): Promise<OutlineEntry[]> {
    if (!this.baselineOutline) this.baselineOutline = await read_outline(this.bytes);
    return this.baselineOutline;
  }

  /**
   * The document's outline (bookmarks), in reading order, each entry's
   * `page` a page id of this document (absent when it points elsewhere).
   * Read the first time it's asked for. Kept through page edits: applying
   * them, exporting pages and inserting some write it back where the
   * operations underneath would lose it.
   */
  async getOutline(): Promise<OutlineEntry[]> {
    return (await this.ensureBaselineOutline()).map((entry) => ({ ...entry }));
  }

  /**
   * The outline as the document looks now: pages numbered by their place
   * among the pages not marked for deletion, entries for those dropped
   * (their children move up a level). What `exportBytes()` would write.
   */
  async getOutlineAsShown(): Promise<OutlineEntry[]> {
    const shown = this.allPageIds().filter((id) => !this.deletions.has(id));
    return remapOutline(await this.ensureBaselineOutline(), new Map(shown.map((id, index) => [id, index + 1])));
  }

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
      png = await renderPageOnPool(this.bytes, id, scale);
      this.previewCache.set(key, png);
    }
    return { ...this.pageInfo(id), png };
  }

  /**
   * Renders every page (or just `options.range`, for a window of a large
   * document), reusing cached PNGs and only fetching the ones actually
   * missing - e.g. after a `rotatePage`/`deletePage` (which never invalidate
   * the cache, see above) a second call renders nothing new. Spreads
   * whatever *is* missing across the worker pool, which holds the document
   * (see preview-worker-pool.ts) so pages after the first don't resend it.
   * `options.onProgress`, if given, fires after each page finishes (in
   * whichever order the workers complete them, not necessarily page order).
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
        const preview = { ...this.pageInfo(id), png: cached };
        previews[indexOf.get(id) as number] = preview;
        options.onPreview?.(preview);
        done += 1;
        reportProgress();
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) return previews;

    const store = (page: number, png: Uint8Array) => {
      this.previewCache.set(cacheKey(page, scale), png);
      const preview = { ...this.pageInfo(page), png };
      previews[indexOf.get(page) as number] = preview;
      options.onPreview?.(preview);
      done += 1;
      reportProgress();
    };

    // Always on the pool, even for a page or two: its workers hold the
    // document, so a render doesn't send the whole file again.
    await renderPagesInParallel(this.bytes, missing, scale, store);

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
    // A photo page keeps its photo through the commit only if it comes out
    // as its photo alone: rotations, annotations and removals get written
    // into the page, and making it again from the JPEG would lose them.
    const changed = new Set([...this.pagesWithAnnotations(), ...this.pagesWithImageRemovals(), ...this.rotations.keys()]);
    const photos = new Map<PageId, PhotoSource>();
    this.allPageIds()
      .filter((id) => !this.deletions.has(id))
      .forEach((id, index) => {
        const photo = this.photos.get(id);
        if (photo && !changed.has(id)) photos.set(index + 1, photo);
      });
    this.bytes = await this.computeCommittedBytes();
    this.photos.clear();
    for (const [page, photo] of photos) this.photos.set(page, photo);
    this.replacedFrom.clear();
    this.pageCount = this.order.length - this.deletions.size;
    this.appliedPageCount = this.pageCount;
    this.rotations.clear();
    this.deletions.clear();
    this.pendingMetadata.clear();
    this.annotationsById.clear();
    this.removedImages.clear();
    this.previewCache.clear();
    this.baselineMetadata = null;
    this.baselineImages = null;
    this.baselineOutline = null;
    this.order = identityOrder(this.pageCount);
    // Recorded only once the wasm work has succeeded, so a failed commit
    // leaves no phantom history step. `pushUndo()` would snapshot the
    // *new* state, hence the pre-computed `before`.
    this.recordSnapshot(before, `Applica modifiche (${this.pageCount} pagine)`);
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
    this.baselineImages = null;
    this.baselineOutline = null;
    this.removedImages.clear();
    this.photos.clear();
    this.recordSnapshot(before, "Cifra documento");
  }

  /** Immediate, whole-document operation - no pending state, nothing to preview. */
  async decrypt(password: string): Promise<void> {
    const before = this.snapshot(this.currentLabel);
    this.bytes = await decrypt_pdf(this.bytes, password);
    this.pageCount = await page_count(this.bytes);
    this.appliedPageCount = this.pageCount;
    this.replacedFrom.clear();
    this.previewCache.clear();
    this.baselineMetadata = null;
    this.baselineImages = null;
    this.baselineOutline = null;
    this.removedImages.clear();
    this.photos.clear();
    this.order = identityOrder(this.pageCount);
    this.recordSnapshot(before, "Decifra documento");
  }

  private async computeCommittedBytes(): Promise<Uint8Array> {
    const survivingIds = this.allPageIds().filter((id) => !this.deletions.has(id));
    if (survivingIds.length === 0) {
      throw new Error("il documento risulterebbe vuoto: annulla almeno un'eliminazione prima di confermare");
    }

    // Annotations first, on the baseline their page ids and coordinates
    // refer to; the page-level steps below then carry them along.
    let bytes = await this.editedBaseline();

    // Skip compose_pdf entirely if nothing actually changed the page
    // sequence - no deletions *and* no reordering (surviving ids still run
    // 1, 2, 3... in order).
    const isUnchangedOrder = survivingIds.every((id, index) => id === index + 1);
    if (!isUnchangedOrder) {
      const layout = survivingIds.map((id) => ({ source: 0, page: id }));
      bytes = await compose_pdf([bytes], layout);
      // compose_pdf leaves the outline behind: written back, following the pages.
      const outline = remapOutline(
        await this.ensureBaselineOutline(),
        new Map(survivingIds.map((id, index) => [id, index + 1])),
      );
      if (outline.length > 0) bytes = await write_outline(bytes, outline);
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
      originalNumber: this.originalNumber(id),
    };
  }

  /** See `PageInfo.originalNumber`. */
  private originalNumber(id: PageId): PageId | null {
    let page = id;
    for (let hops = 0; this.replacedFrom.has(page) && hops < 1000; hops++) page = this.replacedFrom.get(page)!;
    return page <= this.appliedPageCount ? page : null;
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

  /** Validates every id and drops repeats, keeping the first occurrence's place. */
  private distinctPages(ids: PageId[]): PageId[] {
    ids.forEach((id) => this.assertValidPage(id));
    return [...new Set(ids)];
  }

  private assertValidPage(id: PageId): void {
    if (!Number.isInteger(id) || id < 1 || id > this.pageCount) {
      throw new Error(`pagina ${id} inesistente (il documento ne ha ${this.pageCount})`);
    }
  }
}
