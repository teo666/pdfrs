import init, {
  annotate_pdf,
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  image_to_pdf,
  merge_pdfs,
  page_count,
  read_metadata,
  render_page_preview,
  rotate_pages,
  split_pdf,
  write_metadata,
} from "pdfrs-wasm";
import {
  collectTransferables,
  type WorkerInitMessage,
  type WorkerRequest,
  type WorkerResponse,
} from "../../../www/src/worker-protocol.js";

const methods = {
  annotate_pdf,
  compose_pdf,
  decrypt_pdf,
  encrypt_pdf,
  image_to_pdf,
  merge_pdfs,
  page_count,
  read_metadata,
  render_page_preview,
  rotate_pages,
  split_pdf,
  write_metadata,
} as const satisfies Record<string, (...args: never[]) => Promise<unknown>>;

let readyResolve!: (value: unknown) => void;
const ready = new Promise<unknown>((resolve) => {
  readyResolve = resolve;
});

self.onmessage = async (event: MessageEvent<WorkerInitMessage | WorkerRequest>) => {
  const data = event.data;
  if ("type" in data) {
    if (data.type === "wasm-module") readyResolve(init({ module_or_path: data.module }));
    else readyResolve(init());
    return;
  }

  const { id, method, args } = data;
  try {
    await ready;
    const fn = (methods as Record<string, (...values: unknown[]) => Promise<unknown>>)[method];
    if (!fn) throw new Error(`Unknown method: ${method}`);
    const result = await fn(...args);
    const response: WorkerResponse = { id, ok: true, result };
    self.postMessage(response, { transfer: collectTransferables(result) });
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
