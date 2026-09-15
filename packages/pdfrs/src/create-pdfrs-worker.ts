import type { WorkerInitMessage } from "../../../www/src/worker-protocol.js";
import wasmUrl from "pdfrs-wasm/pdfrs_bg.wasm?url";

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

export function createPdfrsWorker(): Worker {
  const worker = new Worker(new URL("./pdfrs.worker.ts", import.meta.url), { type: "module" });

  getCompiledModule()
    .then((module) => {
      const message: WorkerInitMessage = { type: "wasm-module", module };
      worker.postMessage(message);
    })
    .catch((error) => {
      console.error("pdfrs: failed to pre-compile the WASM module, falling back to worker initialization", error);
      const message: WorkerInitMessage = { type: "wasm-init-fallback" };
      worker.postMessage(message);
    });

  return worker;
}
