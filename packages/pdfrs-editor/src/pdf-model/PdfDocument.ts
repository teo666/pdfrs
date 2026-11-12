import {
  annotate_pdf,
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  image_to_pdf,
  is_password_protected,
  merge_pdfs,
  page_count,
  read_metadata,
  rotate_pages,
  write_metadata,
} from "../worker/pdfrs-worker-client";
import { renderPageOnPool, renderPagesInParallel } from "../worker/preview-worker-pool";
import type { TextContent } from "../text/layout";
import type {
  AnnotationId,
  AssetId,
  HistoryEntry,
  ImageAsset,
  PageAnnotation,
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
      this.annotationsById.size > 0 ||
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

    const ids = Array.from({ length: added }, (_, index) => this.pageCount + index + 1);
    const index = Math.max(0, Math.min(at ?? this.order.length, this.order.length));
    this.bytes = merged;
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
      [await this.annotatedBaseline(new Set(pages))],
      pages.map((id) => ({ source: 0, page: id })),
    );
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
  private async annotatedBaseline(pages?: Set<PageId>): Promise<Uint8Array> {
    const annotations = [...this.annotationsById.values()].filter(
      (annotation) => !pages || pages.has(annotation.page),
    );
    if (annotations.length === 0) return this.bytes;

    // Each asset once, however many annotations use it.
    const used = [...new Set(annotations.flatMap((annotation) => (annotation.asset === null ? [] : [annotation.asset])))];
    const index = new Map(used.map((asset, position) => [asset, position]));
    const images = used.map((asset) => this.assets.get(asset) as ImageAsset);
    return annotate_pdf(
      this.bytes,
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
    this.bytes = await this.computeCommittedBytes();
    this.pageCount = this.order.length - this.deletions.size;
    this.rotations.clear();
    this.deletions.clear();
    this.pendingMetadata.clear();
    this.annotationsById.clear();
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

    // Annotations first, on the baseline their page ids and coordinates
    // refer to; the page-level steps below then carry them along.
    let bytes = await this.annotatedBaseline();

    // Skip compose_pdf entirely if nothing actually changed the page
    // sequence - no deletions *and* no reordering (surviving ids still run
    // 1, 2, 3... in order).
    const isUnchangedOrder = survivingIds.every((id, index) => id === index + 1);
    if (!isUnchangedOrder) {
      const layout = survivingIds.map((id) => ({ source: 0, page: id }));
      bytes = await compose_pdf([bytes], layout);
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
