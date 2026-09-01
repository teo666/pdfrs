// Runs the wasm module off the main thread. All the CPU-bound work (parsing,
// merging, rasterizing...) happens here, so the page's UI never freezes while
// it's in progress - see pdfrs-worker-client.ts for the main-thread side.
import init, {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  merge_pdfs,
  page_count,
  render_page_preview,
  rotate_pages,
  split_pdf,
} from "pdfrs";
import { collectTransferables, type WorkerRequest, type WorkerResponse } from "./worker-protocol";

const methods = {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  merge_pdfs,
  page_count,
  render_page_preview,
  rotate_pages,
  split_pdf,
} as const satisfies Record<string, (...args: never[]) => Promise<unknown>>;

type MethodName = keyof typeof methods;

// Not `await`-ed at the top level (module workers don't have uniform
// top-level-await support across browsers yet) - every call waits on this
// promise instead, so requests arriving before init() resolves just queue up.
const ready = init();

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, method, args } = event.data;

  try {
    await ready;
    const fn = methods[method as MethodName] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (!fn) throw new Error(`Unknown method: ${method}`);

    const result = await fn(...args);
    const response: WorkerResponse = { id, ok: true, result };
    self.postMessage(response, { transfer: collectTransferables(result) });
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
