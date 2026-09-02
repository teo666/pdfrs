// Renders many pages in parallel across a small pool of workers - each with
// its own copy of the wasm module - instead of one page at a time on a
// single worker. Only worth the extra wasm instances for documents with
// enough pages; see PARALLEL_PREVIEW_THRESHOLD in main.ts.
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

declare global {
  interface Window {
    // Exposed purely so the e2e smoke test can assert the pool actually ran
    // with more than one worker, without relying on timing.
    __pdfrsLastPreviewPoolSize?: number;
  }
}

/**
 * Renders `pages` (arbitrary page numbers, not necessarily contiguous or
 * sorted - e.g. only the ones missing from a cache) of `bytes` to PNG,
 * spread across a pool of workers. Pages are handed out one at a time from a
 * shared queue - not pre-sliced into fixed per-worker chunks - so a worker
 * that finishes a cheap page immediately grabs the next one instead of
 * idling while another worker is stuck on a heavier page.
 *
 * `onPage` fires as soon as each page finishes, in whatever order workers
 * complete them (not necessarily the order of `pages`) - callers should slot
 * results into their UI keyed by `page`, not by arrival order.
 */
export async function renderPagesInParallel(
  bytes: Uint8Array,
  pages: number[],
  scale: number,
  onPage: (page: number, png: Uint8Array) => void,
  poolSize = Math.min(navigator.hardwareConcurrency || 4, pages.length, 8),
): Promise<void> {
  window.__pdfrsLastPreviewPoolSize = poolSize;

  const workers = Array.from(
    { length: poolSize },
    () => new Worker(new URL("./pdfrs.worker.ts", import.meta.url), { type: "module" }),
  );

  let nextIndex = 0;
  let remaining = pages.length;

  try {
    await new Promise<void>((resolve, reject) => {
      const dispatch = (worker: Worker) => {
        if (nextIndex >= pages.length) return;
        const page = pages[nextIndex++];

        const handleMessage = (event: MessageEvent<WorkerResponse>) => {
          worker.removeEventListener("message", handleMessage);
          const response = event.data;

          if (!response.ok) {
            reject(new Error(response.error));
            return;
          }

          onPage(page, response.result as Uint8Array);
          remaining -= 1;
          if (remaining === 0) resolve();
          else dispatch(worker);
        };

        worker.addEventListener("message", handleMessage);
        const request: WorkerRequest = { id: page, method: "render_page_preview", args: [bytes, page, scale] };
        worker.postMessage(request);
      };

      workers.forEach(dispatch);
    });
  } finally {
    workers.forEach((worker) => worker.terminate());
  }
}
