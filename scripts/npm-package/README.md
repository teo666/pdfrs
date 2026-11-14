# pdfrs.js

PDF manipulation in the browser, written in Rust and compiled to WebAssembly:
merge, split, rotate, rearrange pages across documents, N-up and booklet
layouts, AES-256 encryption, metadata, bookmarks, images, annotations, and page
previews. Everything runs locally: no file leaves the page.

## Two builds

| Import | Size (wasm) | What's in it |
| --- | --- | --- |
| `pdfrs.js/core` | ~1.2 MB | everything except the five functions on the next line |
| `pdfrs.js/full` | ~5.9 MB | `core` plus `render_page_preview` and `PreviewDocument` (pages to PNG), `image_to_pdf` (JPEG to PDF page), `extract_image`, `replace_image` and `compress_images` |

The functions in both builds have the same signatures; pick `core` unless you
need previews or image import.

## Usage

```ts
import init, { merge_pdfs, page_count } from "pdfrs.js/core";

await init(); // once, before the first call

const merged = await merge_pdfs([bytesA, bytesB]); // Uint8Array in, Uint8Array out
console.log(await page_count(merged));
```

`init()` fetches `pdfrs_bg.wasm` next to the JS file, which bundlers such as
Vite handle on their own. To load it yourself, the binaries are exported too:
`pdfrs.js/core/pdfrs_bg.wasm` and `pdfrs.js/full/pdfrs_bg.wasm`
(`init({ module_or_path: url })`).

Every function returns a `Promise`, rejected with a readable `Error` (bad page
range, wrong password…) rather than a panic. They run on the thread that calls
them, though: for a responsive page, call them from a Web Worker.

## Functions

| Function | Does |
| --- | --- |
| `merge_pdfs(files)` | joins PDFs in order |
| `split_pdf(file, ranges)` | one PDF per page range |
| `rotate_pages(file, rotations)` | rotates pages by multiples of 90° |
| `compose_pdf(sources, layout)` | builds a PDF from pages of several PDFs, in any order |
| `nup_pdf(file, options?)` | several pages per sheet |
| `booklet_pdf(file, options?)` | pages arranged for folding into a booklet |
| `encrypt_pdf(file, owner, user, options?)` / `decrypt_pdf(file, password)` | AES-256; `options.permissions` restricts printing, copying, editing… for the user password |
| `read_permissions(file)` | what an encrypted PDF allows, without the password (`null` if not encrypted) |
| `is_password_protected(file)` | whether opening it needs a password |
| `page_count(file)` | number of pages |
| `read_metadata(file)` / `write_metadata(file, patch)` | title, author, dates… (`null` in the patch removes a field) |
| `read_outline(file)` / `write_outline(file, entries)` | bookmarks, as a flat list with levels |
| `list_images(file)` / `remove_images(file, placements)` | images already in the PDF, and where they're drawn |
| `annotate_pdf(file, assets, assetsMeta, annotations)` | stamps text, images and signatures on pages, over or under the content, with any opacity |
| `watermark_pdf(file, options)` | a text watermark across the pages (size to fit, angle, opacity, over or under the content) |
| `blank_page_pdf(width, height)` / `page_sizes(file)` | an empty one-page PDF; every page's size as shown |
| `render_page_preview(file, page, scale)` | a page as PNG (`full` only) |
| `new PreviewDocument(file)` | a PDF read once, to render many pages: `render_page(page, scale)`, `page_count`, `free()` when done (`full` only) |
| `image_to_pdf(file, options?)` | a JPEG as a one-page PDF (`full` only) |
| `extract_image(file, key, maxSize?)` | an image of the PDF as JPEG or PNG (`full` only) |
| `replace_image(file, key, image)` | another picture in the place of an image, everywhere it's drawn (`full` only) |
| `compress_images(file, options?)` | recompresses the images for a lighter file (`full` only) |

The TypeScript declarations (`pdfrs.d.ts`) ship with the package; the full
documentation, with every option, is in the repository's
[`docs/api.md`](https://github.com/teo666/pdfrs/blob/main/docs/api.md)
(in Italian).

## License

MIT or Apache-2.0, at your option.
