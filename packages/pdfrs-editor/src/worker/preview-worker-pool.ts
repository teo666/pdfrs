// Renders pages across a small pool of workers - each with its own instance
// of the wasm module, all instantiated from the same precompiled binaries
// (see create-pdfrs-worker.ts) - instead of one page at a time on a single
// worker.
//
// The pool is persistent at module scope: workers are created lazily (up to
// the largest pool size any call has asked for) and never torn down, so a
// second call pays no worker/wasm startup cost if the pool is already warm -
// unlike an earlier version of this file, which spun up and `terminate()`d a
// fresh set of workers on every single call.
//
// Each worker also *holds* the documents it renders: a document's bytes are
// sent to a worker once, the first time that worker gets one of its pages,
// and every later page names it by a number instead. Sending the bytes
// means a structured clone, done synchronously on the main thread - for a
// 40 MB scan, ~10 ms of frozen UI per page, which a whole document's worth
// of thumbnails turns into seconds. Holding them costs a copy per worker,
// so each keeps only its last few documents, and lets them all go once the
// pool has had nothing to do for a while.
import { createPdfrsWorker } from "./create-pdfrs-worker";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

declare global {
  interface Window {
    // Exposed purely so the e2e smoke test can assert the pool actually ran
    // with more than one worker, without relying on timing.
    __pdfrsLastPreviewPoolSize?: number;
    // How many times a document's bytes were sent to a pool worker, for the
    // tests: once per worker per document, not once per page.
    __pdfrsPreviewBytesSent?: number;
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
/** Documents each worker keeps, most recently used last. */
const HELD_PER_WORKER = 2;
/** With nothing to render for this long, the workers let go of every document. */
const RELEASE_AFTER_MS = 20_000;

const workers: Worker[] = [];
const idleWorkers: Worker[] = [];
const queue: RenderJob[] = [];
/** What each worker holds, as the main thread decided it: the worker only ever does as told. */
const held = new Map<Worker, number[]>();

// A document is known by its bytes' identity: the same Uint8Array is the same
// document. Callers must not change a buffer in place after rendering from
// it (PdfDocument never does: a new baseline is a new buffer).
const documentKeys = new WeakMap<Uint8Array, number>();
let nextKey = 1;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function keyOf(bytes: Uint8Array): number {
  let key = documentKeys.get(bytes);
  if (key === undefined) {
    key = nextKey++;
    documentKeys.set(bytes, key);
  }
  return key;
}

/** Grows the persistent pool up to `target` workers if it isn't there yet - never shrinks it. */
function ensurePoolSize(target: number): void {
  while (workers.length < target) {
    const worker = createPdfrsWorker({ withFull: true });
    workers.push(worker);
    idleWorkers.push(worker);
    held.set(worker, []);
  }
  window.__pdfrsLastPreviewPoolSize = workers.length;
}

/**
 * Hands out queued jobs to every currently-idle worker, preferring one that
 * already holds the job's document.
 */
function pump(): void {
  while (idleWorkers.length > 0 && queue.length > 0) {
    const job = queue.shift() as RenderJob;
    const key = keyOf(job.bytes);
    const holder = idleWorkers.findIndex((worker) => held.get(worker)?.includes(key));
    const [worker] = idleWorkers.splice(holder === -1 ? idleWorkers.length - 1 : holder, 1);
    dispatch(worker as Worker, job, key);
  }
  clearTimeout(releaseTimer);
  if (queue.length === 0 && idleWorkers.length === workers.length) {
    releaseTimer = setTimeout(releaseAll, RELEASE_AFTER_MS);
  }
}

function dispatch(worker: Worker, job: RenderJob, key: number): void {
  const handleMessage = (event: MessageEvent<WorkerResponse>) => {
    worker.removeEventListener("message", handleMessage);
    idleWorkers.push(worker);

    const response = event.data;
    if (response.ok) {
      job.resolve(response.result as Uint8Array);
    } else {
      // Whatever went wrong, don't count on the worker still holding it.
      held.set(worker, (held.get(worker) ?? []).filter((k) => k !== key));
      job.reject(new Error(response.error));
    }

    pump();
  };

  // Most recently used last; the oldest beyond the limit are let go.
  const keys = (held.get(worker) ?? []).filter((k) => k !== key);
  const sendBytes = keys.length === (held.get(worker) ?? []).length;
  keys.push(key);
  const release = keys.splice(0, Math.max(0, keys.length - HELD_PER_WORKER));
  held.set(worker, keys);

  worker.addEventListener("message", handleMessage);
  // `id` is meaningless here (unlike pdfrs-worker-client.ts's shared worker,
  // each pool worker only ever has one job in flight at a time, correlated
  // by this one-off `handleMessage` closure, not by matching ids).
  const request: WorkerRequest = {
    id: 0,
    method: "render_held_page",
    args: [key, job.page, job.scale],
    hold: sendBytes ? { key, bytes: job.bytes } : undefined,
    release,
  };
  if (sendBytes) window.__pdfrsPreviewBytesSent = (window.__pdfrsPreviewBytesSent ?? 0) + 1;
  // Copied, not transferred: the caller keeps using its buffer.
  worker.postMessage(request);
}

/** Every worker lets go of every document it holds (they're sent again if needed). */
function releaseAll(): void {
  for (const worker of workers) {
    const keys = held.get(worker) ?? [];
    if (!keys.length || !idleWorkers.includes(worker)) continue;
    held.set(worker, []);
    worker.postMessage({ type: "release", keys });
  }
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
 *
 * `bytes` is sent to each worker once and then held there (see the top of
 * this file), so it must not be changed in place afterwards: pass a new
 * buffer for new content.
 */
export async function renderPagesInParallel(
  bytes: Uint8Array,
  pages: number[],
  scale: number,
  onPage: (page: number, png: Uint8Array) => void,
  poolSizeHint = Math.min(navigator.hardwareConcurrency || 4, pages.length, MAX_POOL_SIZE),
): Promise<void> {
  ensurePoolSize(Math.max(1, poolSizeHint));

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

/** Renders a single page on the pool (and so from a document a worker may already hold). */
export async function renderPageOnPool(bytes: Uint8Array, page: number, scale: number): Promise<Uint8Array> {
  let result: Uint8Array | undefined;
  await renderPagesInParallel(bytes, [page], scale, (_, png) => (result = png));
  return result as Uint8Array;
}
