// Main-thread client for pdfrs.worker.ts: exposes the exact same function
// signatures as the "pdfrs" wasm package, but every call is a postMessage
// round-trip to the worker instead of a direct call, wrapped back into a
// Promise so call sites don't need to know a worker is involved at all.
import { createPdfrsWorker } from "./create-pdfrs-worker";
import type { ExtractedImage, ImagePageOptions, PdfImages } from "../pdf-model/types";
import type { TextStyle } from "../text/layout";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

const worker = createPdfrsWorker();

let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const response = event.data;
  const entry = pending.get(response.id);
  if (!entry) return; // stale/unknown response id, ignore
  pending.delete(response.id);

  if (response.ok) entry.resolve(response.result);
  else entry.reject(new Error(response.error));
};

function call<T>(method: string, args: unknown[]): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    const request: WorkerRequest = { id, method, args };
    // Structured-clone (copy) the arguments rather than transferring them:
    // call sites often reuse the same source buffer across several calls
    // (e.g. the Preview panel calls page_count then render_page_preview once
    // per page, all with the same bytes) - transferring would detach it
    // after the first call and break every call after that.
    worker.postMessage(request);
  });
}

export function merge_pdfs(files: Uint8Array[]): Promise<Uint8Array> {
  return call("merge_pdfs", [files]);
}

export function split_pdf(file: Uint8Array, ranges: unknown): Promise<Uint8Array[]> {
  return call("split_pdf", [file, ranges]);
}

export function rotate_pages(file: Uint8Array, rotations: unknown): Promise<Uint8Array> {
  return call("rotate_pages", [file, rotations]);
}

export function compose_pdf(sources: Uint8Array[], layout: unknown): Promise<Uint8Array> {
  return call("compose_pdf", [sources, layout]);
}

/** One thing drawn on one page; `asset` indexes into the `assets` array passed alongside. */
export type Annotation = {
  page: number;
  /** Fractions (0..1) of the page as displayed, origin top-left. */
  x: number;
  y: number;
  width: number;
  /** Degrees, clockwise as the reader sees the page, about the image's own centre. Optional: absent means upright. */
  rotation?: number;
  /** Fraction of the displayed page's height. Absent: from `width` and the image's (or text's) proportions. */
  height?: number;
} & (
  | { kind: "image"; asset: number }
  | ({ kind: "text" } & Partial<TextStyle> & { text: string })
);

/**
 * Draws images onto pages, all in one pass.
 *
 * The pixel buffers travel as a top-level array of `Uint8Array` rather than
 * inside objects on purpose: `collectTransferables` recurses into arrays but
 * not into objects, so buffers nested in an options object would be copied
 * instead of transferred - a copy per image, of megabytes each.
 *
 * Note that transferring **neuters** the caller's buffers, so pass copies if
 * you intend to keep using them.
 */
export function annotate_pdf(
  file: Uint8Array,
  assets: Uint8Array[],
  assetsMeta: { width: number; height: number }[],
  annotations: Annotation[],
): Promise<Uint8Array> {
  return call("annotate_pdf", [file, assets, assetsMeta, annotations]);
}

/** Reads the `/Info` metadata. Only the keys actually present come back, so a document without metadata reads as `{}`. */
export function read_metadata(file: Uint8Array): Promise<Record<string, string>> {
  return call("read_metadata", [file]);
}

/** Writes `/Info` metadata. `patch` is three-state per field: key absent = untouched, string = set, `null` = delete the key. */
export function write_metadata(file: Uint8Array, patch: Record<string, string | null>): Promise<Uint8Array> {
  return call("write_metadata", [file, patch]);
}

export function encrypt_pdf(file: Uint8Array, ownerPassword: string, userPassword: string): Promise<Uint8Array> {
  return call("encrypt_pdf", [file, ownerPassword, userPassword]);
}

export function decrypt_pdf(file: Uint8Array, password: string): Promise<Uint8Array> {
  return call("decrypt_pdf", [file, password]);
}

/** The images already in the PDF and every place one is drawn (positions as fractions of the page shown). */
export function list_images(file: Uint8Array): Promise<PdfImages> {
  return call("list_images", [file]);
}

/** Takes away the images drawn at `placements` (ids from `list_images`); images nothing draws any more leave the file. */
export function remove_images(file: Uint8Array, placements: string[]): Promise<Uint8Array> {
  return call("remove_images", [file, placements]);
}

/** One image of the PDF as a file (JPEG as stored, or PNG); `maxSize` caps the longer side, for thumbnails. Full build. */
export function extract_image(file: Uint8Array, key: string, maxSize?: number): Promise<ExtractedImage> {
  return call("extract_image", [file, key, maxSize]);
}

/** True when the PDF can't be opened without a password (it reads as having no pages until decrypted). */
export function is_password_protected(file: Uint8Array): Promise<boolean> {
  return call("is_password_protected", [file]);
}

export function page_count(file: Uint8Array): Promise<number> {
  return call("page_count", [file]);
}

export function render_page_preview(file: Uint8Array, page: number, scale: number): Promise<Uint8Array> {
  return call("render_page_preview", [file, page, scale]);
}

export function image_to_pdf(file: Uint8Array, options: ImagePageOptions = {}): Promise<Uint8Array> {
  return call("image_to_pdf", [file, options]);
}

export type PageSize = "a3" | "a4" | "a5" | "letter" | "legal" | "native";
export type Orientation = "portrait" | "landscape" | "auto";
export type FlowDirection = "horizontal" | "vertical";

export interface NUpOptions {
  pageSize?: PageSize;
  orientation?: Orientation;
  layout?: 1 | 2 | 4 | 6 | 8 | 9 | 16 | { rows: number; cols: number };
  direction?: FlowDirection;
  margin?: number;
  spacing?: number;
  drawBorders?: boolean;
  autoRotate?: boolean;
}

export function nup_pdf(file: Uint8Array, options: NUpOptions = {}): Promise<Uint8Array> {
  return call("nup_pdf", [file, options]);
}

export type BindingEdge = "left" | "right";
export type DuplexMode = "bothSides" | "frontOnly" | "backOnly";

export interface BookletOptions {
  pageSize?: PageSize;
  orientation?: Orientation;
  binding?: BindingEdge;
  duplex?: DuplexMode;
  margin?: number;
  gutter?: number;
  drawBorders?: boolean;
  drawFoldLine?: boolean;
  autoRotate?: boolean;
}

export function booklet_pdf(file: Uint8Array, options: BookletOptions = {}): Promise<Uint8Array> {
  return call("booklet_pdf", [file, options]);
}
