// Runs the wasm module off the main thread. All the CPU-bound work (parsing,
// merging, rasterizing...) happens here, so the page's UI never freezes while
// it's in progress - see pdfrs-worker-client.ts for the main-thread side.
import init, {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  merge_pdfs,
  page_count,
  rotate_pages,
  split_pdf,
} from "pdfrs";
import { collectTransferables, type WorkerInitMessage, type WorkerRequest, type WorkerResponse } from "./worker-protocol";

// Only the "core" build's functions - merge/split/rotate/compose/encrypt/
// decrypt/page_count - are imported statically from "pdfrs". The "full"
// build (`render_page_preview`, `image_to_pdf` - the two functions that pull
// in `hayro`/`image`, ~4MB extra) is loaded lazily below, only the first
// time one of those two is actually requested - see docs/development.md for
// the core/full wasm-pack build split this enables.
const coreMethods = {
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  merge_pdfs,
  page_count,
  rotate_pages,
  split_pdf,
} as const satisfies Record<string, (...args: never[]) => Promise<unknown>>;

const FULL_METHODS = new Set(["render_page_preview", "image_to_pdf"]);

// Cached per worker instance (not shared/compiled-once across workers like
// the core module - see create-pdfrs-worker.ts): each worker that ends up
// needing the full build fetches and inits its own copy, the first time
// it's asked for. Simpler than extending the shared-module machinery to a
// second binary, and the pool in preview-worker-pool.ts only ever asks for
// render_page_preview, so this is exactly one lazy load per pool worker.
let fullModule: Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> | null = null;

function loadFull(): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  if (!fullModule) {
    fullModule = import("pdfrs-full").then(async (mod) => {
      await mod.default();
      return mod as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    });
  }
  return fullModule;
}

async function callMethod(method: string, args: unknown[]): Promise<unknown> {
  const table = FULL_METHODS.has(method)
    ? (await loadFull())
    : (coreMethods as Record<string, (...a: unknown[]) => Promise<unknown>>);
  const fn = table[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (!fn) throw new Error(`Unknown method: ${method}`);
  return fn(...args);
}

// Settled by whichever init message arrives first (see create-pdfrs-worker.ts):
// `wasm-module` inits from an already-compiled module (no fetch/compile here),
// `wasm-init-fallback` falls back to the normal self-fetching `init()`. Every
// request handler below just `await`s this, whichever path filled it in -
// resolving a Promise with another Promise (what `init(...)` returns) makes
// the outer one adopt the inner one's eventual state, so a single await is
// enough even though `readyResolve` is called with a not-yet-settled Promise.
// This only gates the *core* module - the full module (if/when loaded) awaits
// its own init inside `loadFull()`, independently.
let readyResolve!: (value: unknown) => void;
const ready = new Promise<unknown>((resolve) => {
  readyResolve = resolve;
});

self.onmessage = async (event: MessageEvent<WorkerInitMessage | WorkerRequest>) => {
  const data = event.data;

  if ("type" in data) {
    if (data.type === "wasm-module") readyResolve(init(data.module));
    else readyResolve(init());
    return;
  }

  const { id, method, args } = data;

  try {
    await ready;
    const result = await callMethod(method, args);
    const response: WorkerResponse = { id, ok: true, result };
    self.postMessage(response, { transfer: collectTransferables(result) });
  } catch (err) {
    const response: WorkerResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
