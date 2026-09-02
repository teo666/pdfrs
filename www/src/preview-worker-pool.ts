// Renders many pages in parallel across a small pool of workers - each with
// its own copy of the wasm module - instead of one page at a time on a
// single worker. Only worth the extra wasm instances for documents with
// enough pages; see PARALLEL_PREVIEW_THRESHOLD in main.ts.
//
// The pool is persistent at module scope: workers are created lazily (up to
// the largest pool size any call has asked for) and never torn down, so a
// second call pays no worker/wasm startup cost if the pool is already warm -
// unlike an earlier version of this file, which spun up and `terminate()`d a
// fresh set of workers on every single call.
import { createPdfrsWorker } from "./create-pdfrs-worker";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

declare global {
  interface Window {
    // Exposed purely so the e2e smoke test can assert the pool actually ran
    // with more than one worker, without relying on timing.
    __pdfrsLastPreviewPoolSize?: number;
  }
}

interface RenderJob {
  bytes: Uint8Array;
  page: number;
  scale: number;
  resolve: (png: Uint8Array) => void;
  reject: (err: Error) => void;
}

const MAX_POOL_SIZE = 8;
const workers: Worker[] = [];
const idleWorkers: Worker[] = [];
const queue: RenderJob[] = [];

/** Grows the persistent pool up to `target` workers if it isn't there yet - never shrinks it. */
function ensurePoolSize(target: number): void {
  while (workers.length < target) {
    const worker = createPdfrsWorker();
    workers.push(worker);
    idleWorkers.push(worker);
  }
  window.__pdfrsLastPreviewPoolSize = workers.length;
}

/** Hands out queued jobs to every currently-idle worker. */
function pump(): void {
  while (idleWorkers.length > 0 && queue.length > 0) {
    const worker = idleWorkers.pop() as Worker;
    const job = queue.shift() as RenderJob;
    dispatch(worker, job);
  }
}

function dispatch(worker: Worker, job: RenderJob): void {
  const handleMessage = (event: MessageEvent<WorkerResponse>) => {
    worker.removeEventListener("message", handleMessage);
    idleWorkers.push(worker);

    const response = event.data;
    if (response.ok) job.resolve(response.result as Uint8Array);
    else job.reject(new Error(response.error));

    pump();
  };

  worker.addEventListener("message", handleMessage);
  // `id` is meaningless here (unlike pdfrs-worker-client.ts's shared worker,
  // each pool worker only ever has one job in flight at a time, correlated
  // by this one-off `handleMessage` closure, not by matching ids).
  const request: WorkerRequest = { id: 0, method: "render_page_preview", args: [job.bytes, job.page, job.scale] };
  worker.postMessage(request);
}

/**
 * Renders `pages` (arbitrary page numbers, not necessarily contiguous or
 * sorted - e.g. only the ones missing from a cache) of `bytes` to PNG,
 * spread across the persistent pool of workers. Pages are handed out one at
 * a time from a shared queue - not pre-sliced into fixed per-worker chunks -
 * so a worker that finishes a cheap page immediately grabs the next one
 * instead of idling while another worker is stuck on a heavier page.
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
  poolSizeHint = Math.min(navigator.hardwareConcurrency || 4, pages.length, MAX_POOL_SIZE),
): Promise<void> {
  ensurePoolSize(poolSizeHint);

  const jobsDone = Promise.all(
    pages.map(
      (page) =>
        new Promise<void>((resolve, reject) => {
          queue.push({
            bytes,
            page,
            scale,
            resolve: (png) => {
              onPage(page, png);
              resolve();
            },
            reject,
          });
        }),
    ),
  );

  // Jobs only ever get handed to workers inside pump() - queuing them above
  // doesn't dispatch anything by itself, so this call is what actually starts
  // the work (and each dispatch()'s own completion re-calls pump() to keep
  // pulling from the queue as workers free up).
  pump();

  await jobsDone;
}
