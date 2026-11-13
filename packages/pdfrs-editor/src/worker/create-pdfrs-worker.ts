// Every `pdfrs.worker.ts` instance - the single shared one in
// pdfrs-worker-client.ts, and every worker in the pool in
// preview-worker-pool.ts - is created through here, so all of them benefit
// from compiling the (multi-MB) wasm binaries exactly once instead of each
// doing its own fetch + compile.
/// <reference path="../url-imports.d.ts" />
import type { WorkerInitMessage } from "./worker-protocol";

// Both URLs come from the *same installed package* as the wasm-bindgen glue
// that pdfrs.worker.ts imports ("pdfrs.js/core", "pdfrs.js/full"), never from
// a hard-coded path into the repo's build folders. Glue and binary must come
// from the same wasm-pack build: wasm-bindgen hashes its import names
// (`__wbg_instanceof_Map_<hash>`), so a new binary instantiated with an old
// glue fails with "import object field ... is not a Function".
import coreWasmUrl from "pdfrs.js/core/pdfrs_bg.wasm?url";
import fullWasmUrl from "pdfrs.js/full/pdfrs_bg.wasm?url";

const compiled = new Map<string, Promise<WebAssembly.Module>>();

function compileOnce(url: string): Promise<WebAssembly.Module> {
  let module = compiled.get(url);
  if (!module) {
    const absolute = new URL(url, import.meta.url);
    module = WebAssembly.compileStreaming
      ? WebAssembly.compileStreaming(fetch(absolute))
      : fetch(absolute)
          .then((response) => response.arrayBuffer())
          .then((bytes) => WebAssembly.compile(bytes));
    compiled.set(url, module);
  }
  return module;
}

export interface CreatePdfrsWorkerOptions {
  /**
   * Also hand the worker the precompiled "full" binary (preview/image import,
   * ~4MB). Worth it for workers that will certainly need it, like the preview
   * pool: otherwise each of them would fetch and compile its own copy the
   * first time it renders a page.
   */
  withFull?: boolean;
}

/**
 * Creates a new `pdfrs.worker.ts` instance and immediately hands it the
 * shared compiled module(s) (fetched/compiled only once, the first time any
 * worker asks for them, then reused for every worker after that) so it only
 * has to run the cheap `WebAssembly.instantiate` step.
 *
 * The message is posted right after construction, before the worker's own
 * script has necessarily run - that's fine, messages sent to a `Worker`
 * queue up until its script attaches a listener, so nothing is lost.
 */
export function createPdfrsWorker(options: CreatePdfrsWorkerOptions = {}): Worker {
  const worker = new Worker(new URL("./pdfrs.worker.ts", import.meta.url), { type: "module" });

  Promise.all([compileOnce(coreWasmUrl), options.withFull ? compileOnce(fullWasmUrl) : undefined])
    .then(([module, fullModule]) => {
      const message: WorkerInitMessage = { type: "wasm-module", module, fullModule };
      worker.postMessage(message);
    })
    .catch((err) => {
      console.error("pdfrs: failed to pre-compile the wasm module, falling back to per-worker init", err);
      const message: WorkerInitMessage = { type: "wasm-init-fallback" };
      worker.postMessage(message);
    });

  return worker;
}
