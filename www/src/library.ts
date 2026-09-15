export { PdfDocument, type GetPreviewsOptions } from "./pdf-model/PdfDocument.js";
export { PdfEditor } from "./pdf-model/PdfEditor.js";
export type {
  DocumentId,
  HistoryEntry,
  ImagePageOptions,
  MetadataField,
  MetadataPatch,
  PageId,
  PageInfo,
  PagePreview,
  PageRange,
  PdfMetadata,
} from "./pdf-model/types.js";
export { DEFAULT_MAX_SIZE, hasTransparency, imageToRgba, type DecodedImage } from "./image-io.js";
export {
  annotate_pdf as annotatePdf,
  compose_pdf as composePdf,
  decrypt_pdf as decryptPdf,
  encrypt_pdf as encryptPdf,
  image_to_pdf as imageToPdf,
  merge_pdfs as mergePdfs,
  page_count as pageCount,
  read_metadata as readMetadata,
  render_page_preview as renderPagePreview,
  rotate_pages as rotatePages,
  split_pdf as splitPdf,
  write_metadata as writeMetadata,
  type Annotation,
} from "./pdfrs-worker-client.js";
