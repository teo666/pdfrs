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

/** 1-indexed, inclusive page window, e.g. for rendering only part of a large document. */
export interface PageRange {
  start: PageId;
  end: PageId;
}
