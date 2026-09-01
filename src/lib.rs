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

/// Encrypts a PDF file with AES-256. `user_password` is required to open the
/// document; `owner_password` is required to change permissions or remove
/// the encryption.
#[wasm_bindgen]
pub async fn encrypt_pdf(
    file: Uint8Array,
    owner_password: String,
    user_password: String,
) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = load(&file.to_vec())?;
    operations::crypto::encrypt(&mut doc, &owner_password, &user_password)?;
    Ok(save(&mut doc)?)
}

/// Decrypts a PDF file using its owner or user password.
#[wasm_bindgen]
pub async fn decrypt_pdf(file: Uint8Array, password: String) -> std::result::Result<Uint8Array, JsValue> {
    let mut doc = operations::crypto::load_decrypted(&file.to_vec(), &password)?;
    Ok(save(&mut doc)?)
}

#[wasm_bindgen(start)]
pub fn main() {
    utils::set_panic_hook();
}
