// Entry point for www/model-test.html: exposes the pure pdf-model classes on
// `window` purely so www/e2e/pdf-model.mjs can drive them from Playwright's
// `page.evaluate`. Not part of the demo UI (index.html) - PdfDocument/PdfEditor
// don't touch the DOM themselves, this file is the only DOM-adjacent bit,
// and only for test wiring.
import { PdfDocument, PdfEditor } from "pdfrs-editor";
import { read_outline, write_outline } from "pdfrs-editor/operations";

declare global {
  interface Window {
    __pdfModel: {
      PdfDocument: typeof PdfDocument;
      PdfEditor: typeof PdfEditor;
      // Raw operations a test needs to build a fixture or look into a result.
      read_outline: typeof read_outline;
      write_outline: typeof write_outline;
    };
  }
}

window.__pdfModel = { PdfDocument, PdfEditor, read_outline, write_outline };
