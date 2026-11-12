/** 1-indexed page number, stable until the next PdfDocument.commit(). */
export type PageId = number;

/** Assigned by PdfEditor when a document is registered. */
export type DocumentId = number;

export interface PageInfo {
  id: PageId;
  /** Degrees not yet committed (multiple of 90, delta on top of whatever rotation the page already has). */
  pendingRotation: number;
  markedForDeletion: boolean;
}

export interface PagePreview extends PageInfo {
  png: Uint8Array;
}

/** The `/Info` fields this library reads and writes. */
export type MetadataField =
  | "title"
  | "author"
  | "subject"
  | "keywords"
  | "creator"
  | "producer"
  | "creationDate"
  | "modDate";

/** A document's metadata. Only the fields actually present in the PDF appear - an absent field and an empty one are different things. */
export type PdfMetadata = Partial<Record<MetadataField, string>>;

/**
 * A metadata edit, three-state per field: a field left out is untouched,
 * a string sets it, `null` deletes it - so clearing the author doesn't
 * disturb the title.
 */
export type MetadataPatch = Partial<Record<MetadataField, string | null>>;

/** One step in a document's undo history, as returned by `PdfDocument.history()` - oldest first, including the current state and any redoable steps ahead of it. */
export interface HistoryEntry {
  /** Position in the timeline, and the argument `goToHistoryIndex()` takes. */
  index: number;
  /** Human-readable description of the action that produced this state ("Elimina pagina 2"), or "Documento aperto" for the initial one. */
  label: string;
  /** True for the one state the document is actually in right now. */
  current: boolean;
}

/** 1-indexed, inclusive page window, e.g. for rendering only part of a large document. */
export interface PageRange {
  start: PageId;
  end: PageId;
}

/** How `PdfDocument.fromImage()` lays a JPEG out on a page. All fields optional; `{}` gives a page exactly the image's size. */
export interface ImagePageOptions {
  /** "native" (default): the page is exactly as big as the image. "a4"/"letter": the image is centered and scaled to fit. */
  pageSize?: "native" | "a4" | "letter";
  /** Ignored for pageSize "native" (always matches the image's own aspect ratio). Default "auto": matches the image's aspect ratio. */
  orientation?: "portrait" | "landscape" | "auto";
}

/** An image registered with a document for annotations (`PdfDocument.addAsset`). */
export type AssetId = number;

/** Assigned by `PdfDocument.addAnnotation`, never reused within a document. */
export type AnnotationId = number;

/** A decoded image, as `annotate_pdf` wants it: RGBA8, row-major, `width * height * 4` bytes, un-premultiplied alpha. */
export interface ImageAsset {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/**
 * An image placed on a page and not applied yet - a pending edit, like a
 * rotation. Coordinates are fractions (0..1) of the page as it is in the
 * baseline (its `/Rotate` applied, pending rotations *not*): the box stays
 * attached to the content when the page is rotated. `x`/`y` are the box's
 * top-left corner; its height follows from `width` and the image's aspect.
 */
export interface PageAnnotation {
  id: AnnotationId;
  page: PageId;
  asset: AssetId;
  x: number;
  y: number;
  width: number;
  /** Degrees, clockwise as the page is seen (in the same frame as x/y), about the box's own centre. 0 = upright. */
  rotation: number;
  /**
   * Fraction of the page's height, for an image stretched out of its own
   * proportions. `null`: the height follows from `width` and the image.
   */
  height: number | null;
  /**
   * Copies of one signature put on every page share a group. `null` for an
   * annotation that was never applied to all pages.
   */
  group: number | null;
  /**
   * Whether this copy follows its group: linked copies move, resize, turn
   * and go away together. A copy unlinked on one page (e.g. moved off some
   * text there) is edited on its own and leaves the others alone. Always
   * false without a group.
   */
  linked: boolean;
}
