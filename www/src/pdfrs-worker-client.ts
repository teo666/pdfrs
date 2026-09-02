// Main-thread client for pdfrs.worker.ts: exposes the exact same function
// signatures as the "pdfrs" wasm package, but every call is a postMessage
// round-trip to the worker instead of a direct call, wrapped back into a
// Promise so call sites don't need to know a worker is involved at all.
import { createPdfrsWorker } from "./create-pdfrs-worker";
import type { ImagePageOptions } from "./pdf-model/types";
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

export function encrypt_pdf(file: Uint8Array, ownerPassword: string, userPassword: string): Promise<Uint8Array> {
  return call("encrypt_pdf", [file, ownerPassword, userPassword]);
}

export function decrypt_pdf(file: Uint8Array, password: string): Promise<Uint8Array> {
  return call("decrypt_pdf", [file, password]);
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
