# pdfrs

Browser-first TypeScript library for editing PDFs locally with WebAssembly. PDF data stays in the browser; no server upload is required.

## Install

```bash
npm install pdfrs
```

## Usage

```ts
import { PdfDocument } from "pdfrs";

const document = await PdfDocument.open(pdfBytes);
document.rotatePage(1, 90);

const result = await document.exportBytes();
```

The package also exports `PdfEditor`, its public TypeScript types, and camel-case low-level operations such as `mergePdfs`, `splitPdf`, `rotatePages`, `renderPagePreview`, `encryptPdf`, and `decryptPdf`.

`pdfrs` targets modern browsers and runs CPU-bound PDF work in Web Workers. It is not a Node.js PDF library.

## License

Licensed under either the MIT License or the Apache License, Version 2.0, at your option.
