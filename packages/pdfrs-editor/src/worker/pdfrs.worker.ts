// Runs the wasm module off the main thread. All the CPU-bound work (parsing,
// merging, rasterizing...) happens here, so the page's UI never freezes while
// it's in progress - see pdfrs-worker-client.ts for the main-thread side.
import init, {
  annotate_pdf,
  booklet_pdf,
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  is_password_protected,
  list_images,
  merge_pdfs,
  nup_pdf,
  page_count,
  read_metadata,
  read_outline,
  remove_images,
  rotate_pages,
  split_pdf,
  write_metadata,
  write_outline,
} from "pdfrs.js/core";
import type { PreviewDocument } from "pdfrs.js/full";
import { collectTransferables, type WorkerInitMessage, type WorkerRequest, type WorkerResponse } from "./worker-protocol";

// Only the "core" build's functions - merge/split/rotate/compose/encrypt/
// decrypt/page_count/nup/booklet - are imported statically from "pdfrs.js/core". The "full"
// build (`render_page_preview`, `image_to_pdf` - the two functions that pull
// in `hayro`/`image`, ~4MB extra) is loaded lazily below, only the first
// time one of those two is actually requested - see docs/development.md for
// the core/full wasm-pack build split this enables.
const coreMethods = {
  annotate_pdf,
  booklet_pdf,
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  is_password_protected,
  list_images,
  merge_pdfs,
  nup_pdf,
  page_count,
  read_metadata,
  read_outline,
  remove_images,
  rotate_pages,
  split_pdf,
  write_metadata,
  write_outline,
} as const satisfies Record<string, (...args: never[]) => Promise<unknown>>;

const FULL_METHODS = new Set([
  "render_page_preview",
  "image_to_pdf",
  "extract_image",
  "replace_image",
  "compress_images",
]);

// Cached per worker instance: each worker that ends up needing the full
// build instantiates its own copy, the first time it's asked for. Workers
// created with `withFull` (the preview pool, see create-pdfrs-worker.ts)
// receive the binary already compiled in their init message, so they skip
// the fetch + compile; any other worker fetches it itself.
let fullModule: Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> | null = null;
let precompiledFull: WebAssembly.Module | undefined;

function loadFull(): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  if (!fullModule) {
    fullModule = import("pdfrs.js/full").then(async (mod) => {
      await mod.default(precompiledFull ? { module_or_path: precompiledFull } : undefined);
      return mod as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    });
  }
  return fullModule;
}

// Documents held for the preview pool (see preview-worker-pool.ts), by the
// key the pool gave them: sent once, then named in every page request. Kept
// as the bytes the pool sent until the first page is asked for, then as a
// `PreviewDocument`, which has read the file and keeps what its pages share
// (fonts, glyphs...), so the next pages don't pay for reading it again. That
// lives in the wasm memory, outside the garbage collector's reach: whatever
// takes one out of this map must `free()` it (see `letGo`).
const heldDocuments = new Map<number, Uint8Array | PreviewDocument>();

function letGo(key: number): void {
  const document = heldDocuments.get(key);
  heldDocuments.delete(key);
  if (document && !(document instanceof Uint8Array)) document.free();
}

async function renderHeldPage(key: number, page: number, scale: number): Promise<Uint8Array> {
  const document = heldDocuments.get(key);
  if (!document) throw new Error(`pdfrs worker: document ${key} not held`);
  if (!(document instanceof Uint8Array)) return document.render_page(page, scale);

  const full = (await loadFull()) as unknown as typeof import("pdfrs.js/full");
  const read = new full.PreviewDocument(document);
  // Still the one to keep: nothing released or replaced it while the full
  // build was loading.
  if (heldDocuments.get(key) === document) {
    heldDocuments.set(key, read);
    return read.render_page(page, scale);
  }
  try {
    return read.render_page(page, scale);
  } finally {
    read.free();
  }
}

async function callMethod(method: string, args: unknown[]): Promise<unknown> {
  if (method === "render_held_page") {
    const [key, page, scale] = args as [number, number, number];
    return renderHeldPage(key, page, scale);
  }
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
    if (data.type === "release") {
      for (const key of data.keys) letGo(key);
    } else if (data.type === "wasm-module") {
      precompiledFull = data.fullModule;
      readyResolve(init({ module_or_path: data.module }));
    } else {
      readyResolve(init());
    }
    return;
  }

  const { id, method, args } = data;
  // Before anything else: the request may be about the document it carries.
  for (const key of data.release ?? []) letGo(key);
  if (data.hold) {
    letGo(data.hold.key);
    heldDocuments.set(data.hold.key, data.hold.bytes);
  }

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
