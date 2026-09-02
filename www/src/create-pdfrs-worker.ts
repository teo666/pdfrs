// Every `pdfrs.worker.ts` instance in this app - the single shared one in
// pdfrs-worker-client.ts, and every worker in the pool in
// preview-worker-pool.ts - is created through here, so all of them benefit
// from compiling the (multi-MB) wasm binary exactly once instead of each
// doing its own fetch + compile.
import type { WorkerInitMessage } from "./worker-protocol";

// Wasm-bindgen's own `init()` would resolve to this same URL internally if
// left to fetch the binary itself - this couples us to the `<crate name>_bg.wasm`
// naming convention, but that name comes directly from our own Cargo.toml,
// so it's a coupling we control.
const WASM_URL = new URL("../../pkg/pdfrs_bg.wasm", import.meta.url);

let compiledModule: Promise<WebAssembly.Module> | null = null;

function getCompiledModule(): Promise<WebAssembly.Module> {
  if (!compiledModule) {
    compiledModule = WebAssembly.compileStreaming
      ? WebAssembly.compileStreaming(fetch(WASM_URL))
      : fetch(WASM_URL)
          .then((response) => response.arrayBuffer())
          .then((bytes) => WebAssembly.compile(bytes));
  }
  return compiledModule;
}

/**
 * Creates a new `pdfrs.worker.ts` instance and immediately hands it the
 * shared compiled module (fetched/compiled only once, the first time any
 * worker is created, then reused for every worker after that) so it only has
 * to run the cheap `WebAssembly.instantiate` step, not recompile the binary
 * from scratch.
 *
 * The message is posted right after construction, before the worker's own
 * script has necessarily run - that's fine, messages sent to a `Worker`
 * queue up until its script attaches a listener, so nothing is lost.
 */
export function createPdfrsWorker(): Worker {
  const worker = new Worker(new URL("./pdfrs.worker.ts", import.meta.url), { type: "module" });

  getCompiledModule()
    .then((module) => {
      const message: WorkerInitMessage = { type: "wasm-module", module };
      worker.postMessage(message);
    })
    .catch((err) => {
      console.error("pdfrs: failed to pre-compile the wasm module, falling back to per-worker init", err);
      const message: WorkerInitMessage = { type: "wasm-init-fallback" };
      worker.postMessage(message);
    });

  return worker;
}
