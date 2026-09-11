//! Integration tests for the wasm-bindgen-exported API, run in a headless
//! browser via `wasm-pack test --headless --firefox` (or `--chrome`).
//!
//! Each test drives the same public functions a JS caller would use
//! (`merge_pdfs`, `split_pdf`, ...), passing plain JS objects/arrays for
//! options exactly as the frontend would, rather than reaching into the
//! crate's internal types.

#![cfg(target_arch = "wasm32")]

use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::JsValue;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

const ONE_PAGE: &[u8] = include_bytes!("fixtures/one_page.pdf");
const TWO_PAGES: &[u8] = include_bytes!("fixtures/two_pages.pdf");
const FOUR_PAGES: &[u8] = include_bytes!("fixtures/four_pages.pdf");
const PHOTO_JPG: &[u8] = include_bytes!("fixtures/photo.jpg");

fn bytes(data: &[u8]) -> Uint8Array {
    Uint8Array::from(data)
}

fn js_object(fields: &[(&str, u32)]) -> JsValue {
    let obj = Object::new();
    for (key, value) in fields {
        Reflect::set(&obj, &JsValue::from_str(key), &JsValue::from(*value)).unwrap();
    }
    obj.into()
}

/// Like `js_object`, but for string-valued fields - and `None` for an
/// explicit JS `null`, which the metadata patch uses to mean "delete this
/// key" (distinct from leaving the key out entirely).
fn js_string_object(fields: &[(&str, Option<&str>)]) -> JsValue {
    let obj = Object::new();
    for (key, value) in fields {
        let value = match value {
            Some(text) => JsValue::from_str(text),
            None => JsValue::NULL,
        };
        Reflect::set(&obj, &JsValue::from_str(key), &value).unwrap();
    }
    obj.into()
}

fn js_number_object(fields: &[(&str, f64)]) -> JsValue {
    let obj = Object::new();
    for (key, value) in fields {
        Reflect::set(&obj, &JsValue::from_str(key), &JsValue::from_f64(*value)).unwrap();
    }
    obj.into()
}

fn js_field(value: &JsValue, key: &str) -> Option<String> {
    let field = Reflect::get(value, &JsValue::from_str(key)).unwrap();
    field.as_string()
}

fn js_array(items: Vec<JsValue>) -> JsValue {
    let arr = Array::new();
    for item in items {
        arr.push(&item);
    }
    arr.into()
}

/// Independent page count via `lopdf`, to check `pdfrs::page_count` and the
/// output of other operations against - not the function under test.
fn expected_page_count(pdf_bytes: &Uint8Array) -> u32 {
    let doc = lopdf::Document::load_mem(&pdf_bytes.to_vec()).expect("saved PDF should be loadable");
    doc.get_pages().len() as u32
}

#[wasm_bindgen_test]
async fn merge_concatenates_pages_in_order() {
    let merged = pdfrs::merge_pdfs(vec![bytes(TWO_PAGES), bytes(ONE_PAGE)])
        .await
        .expect("merge should succeed");

    assert_eq!(expected_page_count(&merged), 3);
}

#[wasm_bindgen_test]
async fn split_produces_one_document_per_range() {
    let ranges = js_array(vec![js_object(&[("start", 1), ("end", 2)]), js_object(&[("start", 3), ("end", 4)])]);

    let parts = pdfrs::split_pdf(bytes(FOUR_PAGES), ranges)
        .await
        .expect("split should succeed");

    assert_eq!(parts.length(), 2);
    let first: Uint8Array = parts.get(0).into();
    let second: Uint8Array = parts.get(1).into();
    assert_eq!(expected_page_count(&first), 2);
    assert_eq!(expected_page_count(&second), 2);
}

#[wasm_bindgen_test]
async fn rotate_applies_rotation_to_requested_page() {
    let rotations = js_array(vec![js_object(&[("page", 1), ("degrees", 90)])]);

    let rotated = pdfrs::rotate_pages(bytes(ONE_PAGE), rotations)
        .await
        .expect("rotate should succeed");

    let doc = lopdf::Document::load_mem(&rotated.to_vec()).unwrap();
    let page_id = doc.get_pages()[&1];
    let dict = doc.get_object(page_id).unwrap().as_dict().unwrap();
    assert_eq!(dict.get(b"Rotate").and_then(|o| o.as_i64()).ok(), Some(90));
}

#[wasm_bindgen_test]
async fn compose_reorders_pages_across_sources() {
    let layout = js_array(vec![
        js_object(&[("source", 1), ("page", 1)]),
        js_object(&[("source", 0), ("page", 2)]),
        js_object(&[("source", 0), ("page", 1)]),
    ]);

    let composed = pdfrs::compose_pdf(vec![bytes(TWO_PAGES), bytes(ONE_PAGE)], layout)
        .await
        .expect("compose should succeed");

    assert_eq!(expected_page_count(&composed), 3);
}

#[wasm_bindgen_test]
async fn encrypt_then_decrypt_round_trips() {
    let encrypted = pdfrs::encrypt_pdf(bytes(ONE_PAGE), "owner-secret".to_string(), "user-secret".to_string())
        .await
        .expect("encrypt should succeed");

    let decrypted = pdfrs::decrypt_pdf(encrypted, "user-secret".to_string())
        .await
        .expect("decrypt should succeed");

    assert_eq!(expected_page_count(&decrypted), 1);
}

#[wasm_bindgen_test]
async fn decrypt_rejects_wrong_password() {
    let encrypted = pdfrs::encrypt_pdf(bytes(ONE_PAGE), "owner-secret".to_string(), "user-secret".to_string())
        .await
        .expect("encrypt should succeed");

    let result = pdfrs::decrypt_pdf(encrypted, "wrong-password".to_string()).await;
    assert!(result.is_err());
}

#[wasm_bindgen_test]
async fn page_count_matches_the_document() {
    let count = pdfrs::page_count(bytes(TWO_PAGES)).await.expect("page_count should succeed");
    assert_eq!(count, 2);
}

#[wasm_bindgen_test]
async fn render_page_preview_produces_a_png() {
    let png = pdfrs::render_page_preview(bytes(TWO_PAGES), 1, 1.0)
        .await
        .expect("render_page_preview should succeed");

    let png = png.to_vec();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "output should start with the PNG magic bytes");
}

#[wasm_bindgen_test]
async fn render_page_preview_rejects_out_of_bounds_page() {
    let result = pdfrs::render_page_preview(bytes(ONE_PAGE), 5, 1.0).await;
    assert!(result.is_err());
}

#[wasm_bindgen_test]
async fn image_to_pdf_produces_a_native_sized_one_page_pdf() {
    let pdf = pdfrs::image_to_pdf(bytes(PHOTO_JPG), JsValue::UNDEFINED)
        .await
        .expect("image_to_pdf should succeed");

    let doc = lopdf::Document::load_mem(&pdf.to_vec()).unwrap();
    assert_eq!(doc.get_pages().len(), 1);
    let (_, page_id) = doc.get_pages().into_iter().next().unwrap();
    let media_box = doc.get_object(page_id).unwrap().as_dict().unwrap().get(b"MediaBox").unwrap().as_array().unwrap();
    assert_eq!(media_box[2].as_float().unwrap() as u32, 400);
    assert_eq!(media_box[3].as_float().unwrap() as u32, 300);
}

#[wasm_bindgen_test]
async fn image_to_pdf_result_can_be_merged_and_previewed() {
    // Exercises the full "use images and PDFs together" path this feature is
    // for: convert an image to a one-page PDF, merge it with a real PDF, then
    // render the merged result's first page - proving hayro can actually
    // decode the embedded DCTDecode image (not just that the bytes are
    // structurally a valid PDF), and that merge_pdfs's `compress()` call
    // didn't corrupt the JPEG stream.
    let image_pdf = pdfrs::image_to_pdf(bytes(PHOTO_JPG), JsValue::UNDEFINED)
        .await
        .expect("image_to_pdf should succeed");

    let merged = pdfrs::merge_pdfs(vec![image_pdf, bytes(ONE_PAGE)]).await.expect("merge should succeed");
    assert_eq!(expected_page_count(&merged), 2);

    let png = pdfrs::render_page_preview(merged, 1, 1.0)
        .await
        .expect("rendering the merged image page should succeed");
    assert_eq!(&png.to_vec()[..8], b"\x89PNG\r\n\x1a\n");
}

#[wasm_bindgen_test]
async fn image_to_pdf_rejects_non_jpeg_input() {
    let result = pdfrs::image_to_pdf(bytes(ONE_PAGE), JsValue::UNDEFINED).await;
    assert!(result.is_err());
}

#[wasm_bindgen_test]
async fn writes_and_reads_back_metadata() {
    let patch = js_string_object(&[
        ("title", Some("Relazione annuale")),
        ("author", Some("Sofía Ünal")),
        ("creationDate", Some("D:20240115103000+01'00'")),
    ]);

    let written = pdfrs::write_metadata(bytes(ONE_PAGE), patch)
        .await
        .expect("write_metadata should succeed");

    let metadata = pdfrs::read_metadata(written)
        .await
        .expect("read_metadata should succeed");

    // A plain JS object, not a Map - that's what the frontend expects to
    // destructure, and it's the only exported function returning one.
    assert!(!metadata.is_undefined() && !metadata.is_null());
    assert_eq!(js_field(&metadata, "title").as_deref(), Some("Relazione annuale"));
    assert_eq!(js_field(&metadata, "author").as_deref(), Some("Sofía Ünal"));
    assert_eq!(
        js_field(&metadata, "creationDate").as_deref(),
        Some("D:20240115103000+01'00'")
    );
    // A key never written stays absent rather than coming back empty.
    assert_eq!(js_field(&metadata, "subject"), None);
}

/// The three states of the patch have to survive the JS -> Rust boundary
/// intact: a key left out is untouched, `null` deletes, a string sets.
#[wasm_bindgen_test]
async fn metadata_patch_is_three_state() {
    let written = pdfrs::write_metadata(
        bytes(ONE_PAGE),
        js_string_object(&[("title", Some("Titolo")), ("author", Some("Autore"))]),
    )
    .await
    .expect("first write should succeed");

    // Only the author is mentioned, and it's null: the title must survive.
    let updated = pdfrs::write_metadata(written, js_string_object(&[("author", None)]))
        .await
        .expect("second write should succeed");

    let metadata = pdfrs::read_metadata(updated).await.unwrap();
    assert_eq!(js_field(&metadata, "title").as_deref(), Some("Titolo"));
    assert_eq!(js_field(&metadata, "author"), None);
}

#[wasm_bindgen_test]
async fn read_metadata_of_a_document_without_info_is_empty() {
    let metadata = pdfrs::read_metadata(bytes(FOUR_PAGES))
        .await
        .expect("read_metadata should succeed");

    assert!(js_field(&metadata, "title").is_none());
}

#[wasm_bindgen_test]
async fn write_metadata_rejects_an_unknown_field() {
    let result = pdfrs::write_metadata(bytes(ONE_PAGE), js_string_object(&[("bogus", Some("x"))])).await;
    assert!(result.is_err(), "an unknown metadata field should be rejected");
}

/// Counts the XObjects reachable from a page's own /Resources.
fn page_xobject_count(pdf_bytes: &Uint8Array, page: u32) -> usize {
    let doc = lopdf::Document::load_mem(&pdf_bytes.to_vec()).expect("saved PDF should be loadable");
    let page_id = *doc.get_pages().get(&page).expect("page should exist");
    let resources = doc
        .get_dictionary(page_id)
        .unwrap()
        .get(b"Resources")
        .expect("the stamped page should carry its own /Resources");
    let resources = doc.dereference(resources).unwrap().1.as_dict().unwrap();
    match resources.get(b"XObject") {
        Ok(xobjects) => xobjects.as_dict().unwrap().len(),
        Err(_) => 0,
    }
}

#[wasm_bindgen_test]
async fn stamps_an_image_onto_a_page() {
    // 2x2 RGBA: two opaque pixels, two transparent.
    let pixels = Uint8Array::from(
        &[255u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 0][..],
    );
    let placement = js_number_object(&[("x", 0.1), ("y", 0.7), ("width", 0.3)]);

    let stamped = pdfrs::stamp_image(bytes(ONE_PAGE), 1, pixels, 2, 2, placement)
        .await
        .expect("stamp_image should succeed");

    assert!(stamped.length() > 0);
    assert_eq!(expected_page_count(&stamped), 1, "stamping must not change the page count");
    // The image plus its /SMask companion is one entry in /Resources/XObject
    // (the mask hangs off the image's own dict, not off the page).
    assert_eq!(page_xobject_count(&stamped, 1), 1);
}

#[wasm_bindgen_test]
async fn stamp_image_rejects_a_pixel_buffer_of_the_wrong_length() {
    let pixels = Uint8Array::from(&[0u8, 0, 0, 0][..]); // 1 pixel, but 4x4 claimed
    let placement = js_number_object(&[("x", 0.0), ("y", 0.0), ("width", 0.5)]);

    let result = pdfrs::stamp_image(bytes(ONE_PAGE), 1, pixels, 4, 4, placement).await;
    assert!(result.is_err(), "a mismatched pixel buffer should be rejected");
}

#[wasm_bindgen_test]
async fn stamp_image_rejects_a_nonexistent_page() {
    let pixels = Uint8Array::from(&[0u8, 0, 0, 255][..]);
    let placement = js_number_object(&[("x", 0.0), ("y", 0.0), ("width", 0.5)]);

    let result = pdfrs::stamp_image(bytes(ONE_PAGE), 99, pixels, 1, 1, placement).await;
    assert!(result.is_err(), "stamping a page that doesn't exist should be rejected");
}
