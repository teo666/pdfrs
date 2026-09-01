// Shared message shapes between the main thread client (pdfrs-worker-client.ts)
// and the worker itself (pdfrs.worker.ts), so the two sides can't drift apart.

export interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

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
