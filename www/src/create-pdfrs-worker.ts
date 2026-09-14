// Every `pdfrs.worker.ts` instance in this app - the single shared one in
// pdfrs-worker-client.ts, and every worker in the pool in
// preview-worker-pool.ts - is created through here, so all of them benefit
// from compiling the (multi-MB) wasm binary exactly once instead of each
// doing its own fetch + compile.
import type { WorkerInitMessage } from "./worker-protocol";
import wasmUrl from "pdfrs/pdfrs_bg.wasm?url";

// Resolve the binary through the same installed package as the generated JS
// glue imported by `pdfrs.worker.ts`. Pointing straight at ../../pkg is
// unsafe with pnpm's `file:` dependencies: after a wasm-pack rebuild, pkg/
// can contain a new binary while node_modules still contains the old glue.
// Wasm-bindgen import names include hashes, so mixing those two generations
// fails at instantiation with errors such as
// "import object field '__wbg_instanceof_Map_...' is not a Function".
const WASM_URL = new URL(wasmUrl, import.meta.url);

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
