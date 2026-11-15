# Changelog

`pdfrs.js` on npm. Versions follow `Cargo.toml`.

## 0.3.0

### New functions

- `watermark_pdf(file, options)`: a text watermark across the pages. The size fits the page or is given in points; options for angle, position, opacity, the pages, and over or under the content.
- `watermark_image_pdf(file, image, width, height, options)`: an image (RGBA) as a watermark, with the same options. Its transparency is kept, and one image object serves every page.
- `page_labels_pdf(file, options)`: page numbers, headers and footers. A short text per page, at a corner or the middle of the top or bottom edge.
- `blank_page_pdf(width, height)` and `page_sizes(file)`: an empty one-page PDF, and every page's size as shown.
- `move_images(file, moves)`: moves, resizes and turns images already in the PDF. Placement ids stay the same.
- `replace_image(file, key, image)`: another picture in the place of an image, everywhere it's drawn (`full` build).
- `compress_images(file, options)`: a lighter copy with the images recompressed, at three quality levels (`full` build).
- `read_permissions(file)`: what an encrypted PDF allows, read without the password.
- `restore_encryption(original, edited)`: encrypts an edit like its original (same passwords and permissions), for a file with restrictions and no password to open it.
- `PreviewDocument` (`full` build): a PDF read once, to render many pages. `render_page(page, scale)`, `page_count`, `free()`.

### Changed

- `encrypt_pdf(file, owner, user, options?)`: the new `options.permissions` restricts printing, copying, editing and the rest for the user password. Without it, everything is allowed, as before.
- `annotate_pdf`: each annotation can also take `opacity` and `layer` (`"over"` or `"under"` the content).
- `list_images`: each placement also has `clipped` (a clipping path applies where it's drawn) and `rotation`.
- `read_outline` / `write_outline`: entries keep their web link (`uri`), `color`, `bold` and `italic`.
- Stamps, text, images, N-up and booklet now work on the part of the page shown (CropBox within MediaBox), as the previews do.

### Faster previews

- Both builds are compiled with **WebAssembly SIMD**, which hayro's rasterizer uses. A page draws about four times faster, and `full` is smaller: 4.9 MB instead of 6.2. You now need a browser with WebAssembly SIMD: Chrome and Edge 91, Firefox 89, Safari 16.4 or later.
- Previews are encoded as RGB PNG with a faster compression, about 40% quicker to encode. They are still PNG, with the same pixels.

## Before 0.3.0

See the [git history](https://github.com/teo666/pdfrs/commits/main).
