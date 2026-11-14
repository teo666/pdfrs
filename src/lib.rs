mod error;
mod operations;
mod utils;

use js_sys::{Array, Uint8Array};
use lopdf::Document;
use wasm_bindgen::prelude::*;

use error::{PdfrsError, Result};
use operations::compose::PageRef;
use operations::rotate::PageRotation;
use operations::split::PageRange;

fn load(bytes: &[u8]) -> Result<Document> {
    Document::load_mem(bytes).map_err(PdfrsError::from)
}

fn save(doc: &mut Document) -> Result<Uint8Array> {
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(PdfrsError::Save)?;
    Ok(Uint8Array::from(bytes.as_slice()))
}

fn parse_options<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T> {
    serde_wasm_bindgen::from_value(value).map_err(|err| PdfrsError::Options(err.to_string()))
}

/// Concatenates the pages of several PDF files, in the given order, into one PDF.
#[wasm_bindgen]
pub async fn merge_pdfs(files: Vec<Uint8Array>) -> std::result::Result<Uint8Array, JsValue> {
    let docs = files
        .iter()
        .map(|file| load(&file.to_vec()))
        .collect::<Result<Vec<_>>>()?;
    let mut merged = operations::merge::merge(docs)?;
    Ok(save(&mut merged)?)
}

/// Splits a PDF file into several PDFs, one per requested `[start, end]` page range.
/// `ranges` is a JS array of `{ start, end }` objects (1-indexed, inclusive).
#[wasm_bindgen]
pub async fn split_pdf(file: Uint8Array, ranges: JsValue) -> std::result::Result<Array, JsValue> {
    let doc = load(&file.to_vec())?;
    let ranges: Vec<PageRange> = parse_options(ranges)?;
    let parts = operations::split::split(&doc, &ranges)?;

    let out = Array::new();
    for mut part in parts {
        out.push(&save(&mut part)?.into());
    }
    Ok(out)
}

/// Rotates individual pages of a PDF file. `rotations` is a JS array of
/// `{ page, degrees }` objects; `degrees` is added to each page's current rotation
/// and must be a multiple of 90.
#[wasm_bindgen]
pub async fn rotate_pages(file: Uint8Array, rotations: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = load(&file.to_vec())?;
    let rotations: Vec<PageRotation> = parse_options(rotations)?;
    operations::rotate::rotate(&mut doc, &rotations)?;
    Ok(save(&mut doc)?)
}

/// Builds a new PDF by picking pages from several source PDFs, in any order.
/// `layout` is a JS array of `{ source, page }` objects, where `source` is the
/// index of the file within `sources` and `page` is the 1-indexed page number
/// in that source document.
#[wasm_bindgen]
pub async fn compose_pdf(sources: Vec<Uint8Array>, layout: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let docs = sources
        .iter()
        .map(|file| load(&file.to_vec()))
        .collect::<Result<Vec<_>>>()?;
    let layout: Vec<PageRef> = parse_options(layout)?;
    let mut composed = operations::compose::compose(docs, &layout)?;
    Ok(save(&mut composed)?)
}

/// Draws a text watermark on the pages of a PDF. `options` is
/// `{ text, font?, bold?, italic?, color?: "#rrggbb", align?, opacity?: 0..1, size?: number | "fit", angle?, position?: "center"|"top"|"bottom", layer?: "over"|"under", pages?: number[] }`:
/// - `size`: a font size in points, or `"fit"` (the default) for as big as
///   fits in 80% of each page;
/// - `angle`: degrees counter-clockwise as the page is shown (45 by default,
///   rising to the right);
/// - `layer`: over the content (the default) or under it, where anything
///   opaque on the page - a scan - hides it;
/// - `pages`: 1-indexed, every page when absent.
///
/// Defaults: grey, 30% opacity, centred.
#[wasm_bindgen]
pub async fn watermark_pdf(file: Uint8Array, options: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let options: operations::watermark::WatermarkOptions = parse_options(options)?;
    let mut doc = load(&file.to_vec())?;
    operations::watermark::watermark(&mut doc, &options)?;
    Ok(save(&mut doc)?)
}

/// A PDF of one empty page, `width` by `height` points (1 to 14400).
#[wasm_bindgen]
pub async fn blank_page_pdf(width: f64, height: f64) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = operations::watermark::blank_page(width, height)?;
    Ok(save(&mut doc)?)
}

/// Every page's size as it's shown, in points, in page order:
/// `[{ width, height }]` - the visible part (CropBox within MediaBox), its
/// sides swapped for a page turned a quarter by `/Rotate`.
#[wasm_bindgen]
pub async fn page_sizes(file: Uint8Array) -> std::result::Result<JsValue, JsValue> {
    let doc = load(&file.to_vec())?;
    let sizes = operations::watermark::page_sizes(&doc)?;
    serde_wasm_bindgen::to_value(&sizes).map_err(|err| PdfrsError::Options(err.to_string()).into())
}

/// Options for `encrypt_pdf`.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EncryptOptions {
    // An Option so that `permissions: undefined` from JS reads as "not given".
    permissions: Option<operations::crypto::PdfPermissions>,
}

/// Encrypts a PDF file with AES-256. `user_password` is required to open the
/// document; `owner_password` opens it with everything allowed, and is what
/// lifts the restrictions. `options` (optional) is
/// `{ permissions?: { print, printHighQuality, copy, modify, annotate, fillForms, assemble } }`:
/// what the user password allows, each `true` when left out. Restrictions
/// only mean something with an owner password different from the user one.
#[wasm_bindgen]
pub async fn encrypt_pdf(
    file: Uint8Array,
    owner_password: String,
    user_password: String,
    options: JsValue,
) -> std::result::Result<Uint8Array, JsValue> {
    let options: EncryptOptions = if options.is_undefined() || options.is_null() {
        Default::default()
    } else {
        parse_options(options)?
    };
    let mut doc = load(&file.to_vec())?;
    operations::crypto::encrypt(&mut doc, &owner_password, &user_password, options.permissions.unwrap_or_default())?;
    Ok(save(&mut doc)?)
}

/// The permissions of an encrypted PDF - what opening it with the user
/// password allows: `{ print, printHighQuality, copy, modify, annotate, fillForms, assemble }`,
/// or `null` for a PDF that isn't encrypted. Needs no password.
#[wasm_bindgen]
pub async fn read_permissions(file: Uint8Array) -> std::result::Result<JsValue, JsValue> {
    match operations::crypto::read_permissions(&file.to_vec())? {
        None => Ok(JsValue::NULL),
        Some(permissions) => {
            serde_wasm_bindgen::to_value(&permissions).map_err(|err| PdfrsError::Options(err.to_string()).into())
        }
    }
}

/// Decrypts a PDF file using its owner or user password.
#[wasm_bindgen]
pub async fn decrypt_pdf(file: Uint8Array, password: String) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = operations::crypto::load_decrypted(&file.to_vec(), &password)?;
    Ok(save(&mut doc)?)
}

/// True when the PDF can't be opened without a password (it has a user
/// password). Such a PDF reads as having no pages: decrypt it first with
/// `decrypt_pdf`. A PDF with only an owner password reads as `false`.
#[wasm_bindgen]
pub async fn is_password_protected(file: Uint8Array) -> std::result::Result<bool, JsValue> {
    Ok(operations::crypto::needs_password(&file.to_vec())?)
}

/// Returns the number of pages in a PDF file (useful to know how many
/// preview thumbnails to request from `render_page_preview`).
#[wasm_bindgen]
pub async fn page_count(file: Uint8Array) -> std::result::Result<u32, JsValue> {
    let doc = load(&file.to_vec())?;
    Ok(doc.get_pages().len() as u32)
}

/// Draws images onto the pages of an existing PDF - signatures, typically -
/// in one pass.
///
/// Two lists, deliberately kept apart:
///
/// - `assets`: an `Array` of `Uint8Array`, one per image, holding raw RGBA8
///   (`width * height * 4` bytes) that the browser's canvas already decoded.
///   Keeping the decoding out of Rust is what frees this operation of any
///   image-decoding dependency, so it ships in the "core" build. They're a
///   top-level array rather than fields of objects so the worker can
///   *transfer* them instead of copying megabytes per image.
/// - `assets_meta`: `[{ width, height }]`, parallel to `assets`.
/// - `annotations`: `[{ page, x, y, width, kind: "image", asset }]`, where
///   `asset` indexes into `assets`. `x`/`y`/`width` are fractions (0..1) of
///   the page **as displayed**, origin top-left - the coordinates of the
///   preview the user drags the box on. The height follows from the image's
///   aspect ratio.
///
/// The same asset used by several annotations becomes a **single** image
/// stream in the output, referenced from each page that needs it. Pages with
/// a `/Rotate` are handled: the content stream knows nothing about that
/// rotation, so the matrix is converted from displayed space to page space.
#[wasm_bindgen]
pub async fn annotate_pdf(
    file: Uint8Array,
    assets: Array,
    assets_meta: JsValue,
    annotations: JsValue,
) -> std::result::Result<Uint8Array, JsValue> {
    #[derive(serde::Deserialize)]
    struct AssetMeta {
        width: u32,
        height: u32,
    }

    let meta: Vec<AssetMeta> = parse_options(assets_meta)?;
    if meta.len() != assets.length() as usize {
        return Err(PdfrsError::InvalidArgument(format!(
            "assets e assets_meta hanno lunghezze diverse: {} e {}",
            assets.length(),
            meta.len()
        ))
        .into());
    }

    // Held in a Vec so the borrowed slices below outlive the call.
    let pixel_buffers: Vec<Vec<u8>> = assets
        .iter()
        .map(|value| Uint8Array::new(&value).to_vec())
        .collect();

    let assets: Vec<operations::stamp::ImageAsset> = pixel_buffers
        .iter()
        .zip(meta.iter())
        .map(|(pixels, meta)| operations::stamp::ImageAsset {
            pixels,
            width: meta.width,
            height: meta.height,
        })
        .collect();

    let annotations: Vec<operations::stamp::Annotation> = parse_options(annotations)?;

    let mut doc = load(&file.to_vec())?;
    operations::stamp::annotate(&mut doc, &assets, &annotations)?;
    Ok(save(&mut doc)?)
}

/// Reads a PDF's `/Info` metadata as a JS object with the keys that are
/// actually present (`{ title?, author?, subject?, keywords?, creator?,
/// producer?, creationDate?, modDate? }`). Dates come back as the raw PDF
/// date string (`"D:20240115103000+01'00'"`). A document without any
/// metadata reads as `{}` rather than failing.
#[wasm_bindgen]
pub async fn read_metadata(file: Uint8Array) -> std::result::Result<JsValue, JsValue> {
    let doc = load(&file.to_vec())?;
    let metadata = operations::metadata::read(&doc);
    // The only exported function returning a structured object rather than
    // bytes - a struct (not a map) precisely because serde_wasm_bindgen
    // serializes a map as a JS `Map`, and callers want a plain object.
    serde_wasm_bindgen::to_value(&metadata).map_err(|err| PdfrsError::Options(err.to_string()).into())
}

/// Writes a PDF's `/Info` metadata. `patch` is a JS object that is
/// three-state per field: a key left out is untouched, a string sets it, and
/// `null` deletes it - so clearing the author doesn't disturb the title.
/// Unknown keys are rejected rather than written into the trailer.
#[wasm_bindgen]
pub async fn write_metadata(file: Uint8Array, patch: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = load(&file.to_vec())?;
    let patch: std::collections::HashMap<String, Option<String>> = parse_options(patch)?;
    operations::metadata::write(&mut doc, &patch)?;
    Ok(save(&mut doc)?)
}

/// The images already in a PDF: `{ images: [...], placements: [...] }` -
/// each distinct image (key, size in pixels, format, stored bytes, colour
/// space, mask), and each place one is drawn (placement id, page, image key,
/// corners and box as fractions of the page shown, other pages sharing the
/// same Form). See `operations::images`.
#[wasm_bindgen]
pub async fn list_images(file: Uint8Array) -> std::result::Result<JsValue, JsValue> {
    let doc = load(&file.to_vec())?;
    let report = operations::images::list(&doc)?;
    serde_wasm_bindgen::to_value(&report).map_err(|err| PdfrsError::Options(err.to_string()).into())
}

/// Takes away the images drawn at `placements` (an array of placement ids
/// from `list_images`); an image nothing draws any more is deleted from the
/// file.
#[wasm_bindgen]
pub async fn remove_images(file: Uint8Array, placements: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = load(&file.to_vec())?;
    let placements: Vec<String> = parse_options(placements)?;
    operations::images::remove(&mut doc, &placements)?;
    Ok(save(&mut doc)?)
}

/// An image of the PDF (`key` from `list_images`) as a file of its own:
/// `{ mime, width, height, bytes }` - the JPEG as stored when it can be,
/// otherwise a PNG. `maxSize`, if given, caps the longer side (thumbnails).
#[cfg(all(feature = "preview", feature = "image-import"))]
#[wasm_bindgen]
pub async fn extract_image(
    file: Uint8Array,
    key: String,
    max_size: Option<u32>,
) -> std::result::Result<JsValue, JsValue> {
    let image = operations::image_extract::extract(&file.to_vec(), &key, max_size)?;
    let out = js_sys::Object::new();
    js_sys::Reflect::set(&out, &"mime".into(), &image.mime.into())?;
    js_sys::Reflect::set(&out, &"width".into(), &image.width.into())?;
    js_sys::Reflect::set(&out, &"height".into(), &image.height.into())?;
    js_sys::Reflect::set(&out, &"bytes".into(), &Uint8Array::from(image.bytes.as_slice()).into())?;
    Ok(out.into())
}

/// Puts the picture `image` (a JPEG or a PNG file) in the place of the
/// image `key` (from `list_images`), wherever that image is drawn. A
/// picture of other proportions is fitted inside the old one's box, with
/// transparent margins; the pages themselves don't change.
#[cfg(all(feature = "preview", feature = "image-import"))]
#[wasm_bindgen]
pub async fn replace_image(file: Uint8Array, key: String, image: Uint8Array) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = load(&file.to_vec())?;
    operations::image_edit::replace(&mut doc, &key, &image.to_vec())?;
    Ok(save(&mut doc)?)
}

/// Recompresses the PDF's images to make it lighter. `options` is
/// `{ level?: "high"|"balanced"|"small" }` (default "balanced"). Returns
/// `{ bytes, considered, recompressed, bytesBefore, bytesAfter }`: the new
/// PDF, how many images could be recompressed, how many came out lighter
/// and were put in, and those images' stored size before and after.
#[cfg(all(feature = "preview", feature = "image-import"))]
#[wasm_bindgen]
pub async fn compress_images(file: Uint8Array, options: JsValue) -> std::result::Result<JsValue, JsValue> {
    let options: operations::image_edit::CompressOptions = if options.is_undefined() || options.is_null() {
        Default::default()
    } else {
        parse_options(options)?
    };
    let (bytes, report) = operations::image_edit::compress(&file.to_vec(), options)?;
    let out = serde_wasm_bindgen::to_value(&report).map_err(|err| PdfrsError::Options(err.to_string()))?;
    js_sys::Reflect::set(&out, &"bytes".into(), &Uint8Array::from(bytes.as_slice()).into())?;
    Ok(out)
}

/// A PDF's outline (bookmarks) as a flat list in reading order: `[{ title,
/// level, page?, top?, open }]` - `level` 1 for the top, `page` 1-based and
/// absent for an entry pointing outside the document. Empty when there is none.
#[wasm_bindgen]
pub async fn read_outline(file: Uint8Array) -> std::result::Result<JsValue, JsValue> {
    let doc = load(&file.to_vec())?;
    let entries = operations::outline::read(&doc);
    serde_wasm_bindgen::to_value(&entries).map_err(|err| PdfrsError::Options(err.to_string()).into())
}

/// Replaces a PDF's outline with `entries` (same shape as `read_outline`
/// returns); an empty array removes it.
#[wasm_bindgen]
pub async fn write_outline(file: Uint8Array, entries: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = load(&file.to_vec())?;
    let entries: Vec<operations::outline::OutlineEntry> = parse_options(entries)?;
    operations::outline::write(&mut doc, &entries)?;
    Ok(save(&mut doc)?)
}

/// Rearranges the pages of a PDF into an N-up layout on newly generated sheets.
/// `options` is a JS object `{ pageSize?: "a3"|"a4"|"a5"|"letter"|"legal"|"native", orientation?: "portrait"|"landscape"|"auto", layout?: 1|2|4|6|8|9|16|{ rows: number, cols: number }, direction?: "horizontal"|"vertical", margin?: number, spacing?: number, drawBorders?: boolean, autoRotate?: boolean }`
/// (all fields optional).
#[wasm_bindgen]
pub async fn nup_pdf(file: Uint8Array, options: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let doc = load(&file.to_vec())?;
    let options: operations::nup::NUpOptions = if options.is_undefined() || options.is_null() {
        Default::default()
    } else {
        parse_options(options)?
    };
    let mut transformed = operations::nup::nup(&doc, options)?;
    Ok(save(&mut transformed)?)
}

/// Imposes pages into a saddle-stitched folded booklet (libretto rilegato).
/// `options` is a JS object `{ pageSize?: "a3"|"a4"|"a5"|"letter"|"legal"|"native", orientation?: "portrait"|"landscape"|"auto", binding?: "left"|"right", duplex?: "bothSides"|"frontOnly"|"backOnly", margin?: number, gutter?: number, drawBorders?: boolean, drawFoldLine?: boolean, autoRotate?: boolean }`
/// (all fields optional).
#[wasm_bindgen]
pub async fn booklet_pdf(file: Uint8Array, options: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let doc = load(&file.to_vec())?;
    let options: operations::booklet::BookletOptions = if options.is_undefined() || options.is_null() {
        Default::default()
    } else {
        parse_options(options)?
    };
    let mut transformed = operations::booklet::booklet(&doc, options)?;
    Ok(save(&mut transformed)?)
}

/// Renders `page` (1-indexed) of a PDF file to a PNG image, for use as a
/// browser preview thumbnail. `scale` multiplies the page's native size (e.g.
/// `1.5` for a sharper-than-1:1 preview). Expects already-decrypted bytes.
///
/// Behind the `preview` feature (pulls in `hayro`, the pure-Rust rasterizer,
/// ~4.3MB of the wasm binary) - see docs/development.md for the "core"/"full"
/// wasm-pack build split this enables.
#[cfg(feature = "preview")]
#[wasm_bindgen]
pub async fn render_page_preview(file: Uint8Array, page: u32, scale: f32) -> std::result::Result<Uint8Array, JsValue> {
    let png = operations::preview::render_page_preview(&file.to_vec(), page, scale)?;
    Ok(Uint8Array::from(png.as_slice()))
}

/// A PDF read once and kept in memory, to render many of its pages: the file
/// is copied into wasm and parsed only when the object is built, and fonts,
/// glyphs and colour spaces shared between pages are decoded once. Rendering
/// the 10th page costs the page alone, not the whole file again as with
/// `render_page_preview`. Expects already-decrypted bytes.
///
/// It holds a copy of the file inside the wasm memory until `free()` is
/// called: call it when done (or use `using`, where supported).
///
/// Behind the `preview` feature, like `render_page_preview`.
#[cfg(feature = "preview")]
#[wasm_bindgen]
pub struct PreviewDocument(operations::preview::PreviewDocument);

#[cfg(feature = "preview")]
#[wasm_bindgen]
impl PreviewDocument {
    /// Reads `file`. Throws if it isn't a PDF hayro can read.
    #[wasm_bindgen(constructor)]
    pub fn new(file: Vec<u8>) -> std::result::Result<PreviewDocument, JsValue> {
        Ok(PreviewDocument(operations::preview::PreviewDocument::new(file)?))
    }

    /// Number of pages.
    #[wasm_bindgen(getter)]
    pub fn page_count(&self) -> u32 {
        self.0.page_count()
    }

    /// Renders `page` (1-indexed) to a PNG image; `scale` multiplies the
    /// page's native size, as in `render_page_preview`.
    pub fn render_page(&self, page: u32, scale: f32) -> std::result::Result<Uint8Array, JsValue> {
        let png = self.0.render_page(page, scale)?;
        Ok(Uint8Array::from(png.as_slice()))
    }
}

/// Builds a one-page PDF with `file` (a JPEG) drawn on it. `options` is a JS
/// object `{ pageSize?: "native"|"a4"|"letter", orientation?: "portrait"|"landscape"|"auto", margin?: number }`
/// (`margin`: points of white space around the image on an A4/Letter page)
/// (all fields optional; pass `undefined`/`null`/`{}` for the default - a
/// page exactly the size of the image).
///
/// Behind the `image-import` feature (pulls in the `image` crate) - see
/// docs/development.md for the "core"/"full" wasm-pack build split this enables.
#[cfg(feature = "image-import")]
#[wasm_bindgen]
pub async fn image_to_pdf(file: Uint8Array, options: JsValue) -> std::result::Result<Uint8Array, JsValue> {
    let options: operations::image::ImagePageOptions = if options.is_undefined() || options.is_null() {
        Default::default()
    } else {
        parse_options(options)?
    };
    let pdf_bytes = operations::image::image_to_pdf(&file.to_vec(), options)?;
    Ok(Uint8Array::from(pdf_bytes.as_slice()))
}

// Named `start`, not `main`: `#[wasm_bindgen(start)]` works with any
// function name, and calling it `main` makes wasm-bindgen refuse to link the
// test harness ("the name `main` is exported by multiple crates in this
// build"), which is what kept `wasm-pack test` from running at all.
#[wasm_bindgen(start)]
pub fn start() {
    utils::set_panic_hook();
}
