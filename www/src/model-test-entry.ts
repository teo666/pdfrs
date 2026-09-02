// Entry point for www/model-test.html: exposes the pure pdf-model classes on
// `window` purely so www/e2e/pdf-model.mjs can drive them from Playwright's
// `page.evaluate`. Not part of the demo UI (index.html) - PdfDocument/PdfEditor
// don't touch the DOM themselves, this file is the only DOM-adjacent bit,
// and only for test wiring.
import { PdfDocument } from "./pdf-model/PdfDocument";
import { PdfEditor } from "./pdf-model/PdfEditor";

declare global {
  interface Window {
    __pdfModel: { PdfDocument: typeof PdfDocument; PdfEditor: typeof PdfEditor };
  }
}

window.__pdfModel = { PdfDocument, PdfEditor };
