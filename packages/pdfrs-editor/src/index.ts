// Public entry point of pdfrs-editor: the framework-agnostic document model
// (PdfDocument/PdfEditor) plus the worker-backed low-level operations, ready
// to be wrapped by any UI (the web components in www/, the Vue app, ...).
//
// Everything here runs the wasm module off the main thread: the model never
// calls "pdfrs.js" directly, only through pdfrs-worker-client.ts.
export { PdfDocument, type GetPreviewsOptions } from "./pdf-model/PdfDocument";
export { PdfEditor } from "./pdf-model/PdfEditor";
export type * from "./pdf-model/types";

// The low-level operations (merge_pdfs, nup_pdf, ...) live in the
// "pdfrs-editor/operations" subpath; only their option types are re-exported here.
export type {
  Annotation,
  BindingEdge,
  BookletOptions,
  DuplexMode,
  FlowDirection,
  NUpOptions,
  Orientation,
  PageSize,
} from "./worker/pdfrs-worker-client";
export { renderPagesInParallel } from "./worker/preview-worker-pool";
