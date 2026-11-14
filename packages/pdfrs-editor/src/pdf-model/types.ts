import type { StandardFont, TextAlign, TextContent } from "../text/layout";

/** 1-indexed page number, stable until the next PdfDocument.commit(). */
export type PageId = number;

/** Assigned by PdfEditor when a document is registered. */
export type DocumentId = number;

export interface PageInfo {
  id: PageId;
  /** Degrees not yet committed (multiple of 90, delta on top of whatever rotation the page already has). */
  pendingRotation: number;
  markedForDeletion: boolean;
  /**
   * Its number in the document as last applied (or as opened): where it
   * comes from, for a UI to say "was page 4" after a move. A photo page put
   * on another page keeps the number of the page it replaced; a page added
   * since has none (null).
   */
  originalNumber: PageId | null;
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

/**
 * What a history step did, for a UI to describe in its own language: a
 * `type` (e.g. "rotatePage") and its parameters (e.g. `{ page: 3, degrees: 90 }`).
 * Annotations carry `kind`: "text", "signature" or "image".
 */
export interface HistoryAction {
  type: string;
  params: Record<string, string | number>;
}

/** One step in a document's undo history, as returned by `PdfDocument.history()` - oldest first, including the current state and any redoable steps ahead of it. */
export interface HistoryEntry {
  /** Position in the timeline, and the argument `goToHistoryIndex()` takes. */
  index: number;
  /** Human-readable description of the action that produced this state ("Elimina pagina 2"), or "Documento aperto" for the initial one. */
  label: string;
  /** True for the one state the document is actually in right now. */
  current: boolean;
  /** The same step described as data (see `HistoryAction`). `label` is its Italian rendering. */
  action: HistoryAction;
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
  /** White space around the image on an A4/Letter page, in PDF points (28.35 = 1 cm). Ignored for "native". Default 0. */
  margin?: number;
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
/** One entry of a PDF's outline (bookmarks), in a flat list where `level` gives the nesting. */
export interface OutlineEntry {
  title: string;
  /** 1 for the top level; an entry's children follow it with its level + 1. */
  level: number;
  /** The page it points to: a page id (`PdfDocument.getOutline`) or a page number (the raw operations). Absent when it points outside the document. */
  page?: PageId | null;
  /** Where on the page, in PDF units from the bottom, when the PDF says. */
  top?: number | null;
  /** Whether its children show when the document opens. */
  open: boolean;
  /** A web address it opens instead of a page, if it does. */
  uri?: string;
  /** `#rrggbb` its title is shown in, if not the reader's default. */
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

/** One distinct image already in the PDF (see `PdfDocument.getImages`). */
export interface PdfImageInfo {
  /** Identifies the image: `"12 0"` for an image object, `"inline:…"` for an inline one. */
  key: string;
  /** In pixels. */
  width: number;
  height: number;
  /** How it's stored: `jpeg`, `jpx`, `jbig2`, `ccitt`, `flate`, `lzw`, `rle`, `raw` or `other`. */
  format: string;
  /** Size of the stored (compressed) data. */
  bytes: number;
  colorSpace?: string;
  bitsPerComponent?: number;
  /** Parts of it are transparent (soft mask or mask). */
  hasMask: boolean;
  inline: boolean;
}

/** One place an image is drawn: fractions of the page as shown in the baseline (its /Rotate applied, pending rotations not), origin top-left - the frame of `PageAnnotation`. */
export interface PdfImagePlacement {
  /** What `removeImages` takes. The same on every page that draws the same Form. */
  id: string;
  page: PageId;
  /** The `PdfImageInfo.key` drawn. */
  image: string;
  /** Top-left, top-right, bottom-right, bottom-left corners of the image. */
  corners: [[number, number], [number, number], [number, number], [number, number]];
  /** The box around the corners. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Other pages drawing the same Form: removing it here removes it there too, and it can't be moved. */
  sharedPages: PageId[];
  /** A clipping path applies where it's drawn: part of it may not show, and moved it may be cut off. */
  clipped: boolean;
}

/** A placement's new box (see `PdfDocument.moveImage`), in the frame of `PdfImagePlacement`. */
export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfImages {
  images: PdfImageInfo[];
  placements: PdfImagePlacement[];
}

/** An image of the PDF as a file of its own (`PdfDocument.extractImage`). */
export interface ExtractedImage {
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** How much `compressDocument` gives up for a lighter file: about 220, 150 or 100 dpi. */
export type CompressionLevel = "high" | "balanced" | "small";

/**
 * What opening a protected PDF with its *user* password allows (the PDF's
 * permission flags). Opened with the owner password everything is allowed,
 * so restrictions only mean something with a different owner password. They
 * ask the reader to hold back; a reader that ignores them can do anything.
 */
export interface PdfPermissions {
  print: boolean;
  /** Print at full quality, not a degraded copy. Never without `print`. */
  printHighQuality: boolean;
  /** Copy text and images out (always allowed for accessibility tools). */
  copy: boolean;
  /** Change the content. */
  modify: boolean;
  /** Add or change comments, fill in forms. */
  annotate: boolean;
  /** Fill in form fields, even without `annotate`. */
  fillForms: boolean;
  /** Insert, rotate or delete pages and change bookmarks, even without `modify`. */
  assemble: boolean;
}

/** A text watermark: see `PdfDocument.addWatermark`. */
export interface WatermarkOptions {
  /** One or more lines (`\n`), in a PDF standard font (WinAnsi characters). */
  text: string;
  font?: StandardFont;
  bold?: boolean;
  italic?: boolean;
  /** `#rrggbb`; grey when absent. */
  color?: string;
  /** How the lines line up; centred when absent. */
  align?: TextAlign;
  /** 0 to 1; 0.3 when absent. */
  opacity?: number;
  /** A font size in points, or "fit" (the default): as big as fits in 80% of each page. */
  size?: number | "fit";
  /** Degrees, counter-clockwise as the page is shown: 45 (the default) rises to the right, 0 is horizontal. */
  angle?: number;
  position?: "center" | "top" | "bottom";
  /** Over the content (the default), or under it - where anything opaque on the page (a scan) hides it. */
  layer?: "over" | "under";
}

/** A page's size as it's shown, in points (visible part, `/Rotate` applied). */
export interface PageDimensions {
  width: number;
  height: number;
}

/** How `PdfEditor.protectDocument` protects a document. */
export interface ProtectOptions {
  /** Opens the file with everything allowed and lifts the restrictions. Required, and different from the password, when `permissions` restricts anything. Defaults to the password. */
  ownerPassword?: string;
  /** What the password allows; each permission left out is allowed. */
  permissions?: Partial<PdfPermissions>;
}

/** What `PdfEditor.compressDocument` did. */
export interface CompressResult {
  /** The lighter copy, registered as a new document; `null` when no image came out lighter. */
  id: DocumentId | null;
  /** The whole file's size, before and after. */
  bytesBefore: number;
  bytesAfter: number;
  /** Images that could be recompressed, and those that came out lighter. */
  considered: number;
  recompressed: number;
}

export interface PageAnnotation {
  id: AnnotationId;
  page: PageId;
  /** The image placed, for an image annotation; `null` for text. */
  asset: AssetId | null;
  /** The text placed, for a text annotation (real text, in a standard font); `null` for an image. */
  text: TextContent | null;
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
