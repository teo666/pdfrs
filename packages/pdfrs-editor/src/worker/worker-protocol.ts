// Shared message shapes between the main thread client (pdfrs-worker-client.ts)
// and the worker itself (pdfrs.worker.ts), so the two sides can't drift apart.

export interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
  /**
   * Pool workers only (see preview-worker-pool.ts): a document to keep from
   * now on, under `key` - for `render_held_page`, which names its document
   * by key instead of carrying its bytes.
   */
  hold?: { key: number; bytes: Uint8Array };
  /** Pool workers only: documents to let go of, by key. */
  release?: number[];
}

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/**
 * Sent by `createPdfrsWorker()` right after constructing a worker, so it can
 * `init()` the wasm module from an already-compiled `WebAssembly.Module`
 * instead of fetching/compiling its own copy (see create-pdfrs-worker.ts).
 * `wasm-init-fallback` is the escape hatch if compiling that module ourselves
 * failed for any reason - the worker then self-initializes the normal way.
 */
export type WorkerInitMessage =
  | {
      type: "wasm-module";
      module: WebAssembly.Module;
      /** The precompiled "full" binary, only for workers created with `withFull` (the preview pool). */
      fullModule?: WebAssembly.Module;
    }
  | { type: "wasm-init-fallback" }
  /** Pool workers only: let go of these held documents (the pool has been idle a while). */
  | { type: "release"; keys: number[] };

/**
 * Collects the underlying ArrayBuffers of any Uint8Array found in `value`
 * (recursing into arrays), so postMessage can transfer them instead of
 * structured-cloning (copying) the bytes across the thread boundary.
 *
 * Transferring detaches the buffer on the sender's side - only safe for
 * throwaway buffers the sender won't read again afterwards, which is the
 * case here (every call site re-reads the source File into a fresh buffer).
 */
export function collectTransferables(value: unknown): Transferable[] {
  if (value instanceof Uint8Array) return [value.buffer as Transferable];
  if (Array.isArray(value)) return value.flatMap(collectTransferables);
  return [];
}
