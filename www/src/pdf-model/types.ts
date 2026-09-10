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
