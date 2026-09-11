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
        .expect("an annotated page should carry its own /Resources");
    let resources = doc.dereference(resources).unwrap().1.as_dict().unwrap();
    match resources.get(b"XObject") {
        Ok(xobjects) => xobjects.as_dict().unwrap().len(),
        Err(_) => 0,
    }
}

/// How many times a page actually *draws* an XObject.
///
/// Not the same as what its /Resources list: many PDFs (these fixtures
/// included) share one /Resources dictionary across every page, so declaring
/// an image for one page makes it visible to all of them. Only the `Do`
/// operators in the content stream decide what gets painted.
fn page_draw_count(pdf_bytes: &Uint8Array, page: u32) -> usize {
    let doc = lopdf::Document::load_mem(&pdf_bytes.to_vec()).expect("saved PDF should be loadable");
    let page_id = *doc.get_pages().get(&page).expect("page should exist");
    doc.get_and_decode_page_content(page_id)
        .expect("page content should decode")
        .operations
        .iter()
        .filter(|operation| operation.operator == "Do")
        .count()
}

/// Every image stream in the document, however many pages reference it.
fn image_stream_count(pdf_bytes: &Uint8Array) -> usize {
    let doc = lopdf::Document::load_mem(&pdf_bytes.to_vec()).expect("saved PDF should be loadable");
    doc.objects
        .values()
        .filter(|object| {
            object
                .as_stream()
                .ok()
                .and_then(|stream| stream.dict.get(b"Subtype").ok())
                .and_then(|subtype| subtype.as_name().ok())
                == Some(b"Image".as_ref())
        })
        .count()
}

/// A 2x2 RGBA image: `alpha` applied to every pixel.
fn rgba_square(r: u8, g: u8, b: u8, alpha: u8) -> Uint8Array {
    let mut pixels = Vec::new();
    for _ in 0..4 {
        pixels.extend_from_slice(&[r, g, b, alpha]);
    }
    Uint8Array::from(pixels.as_slice())
}

fn annotation(page: u32, x: f64, y: f64, width: f64, asset: u32) -> JsValue {
    let obj = Object::new();
    Reflect::set(&obj, &JsValue::from_str("page"), &JsValue::from(page)).unwrap();
    Reflect::set(&obj, &JsValue::from_str("x"), &JsValue::from_f64(x)).unwrap();
    Reflect::set(&obj, &JsValue::from_str("y"), &JsValue::from_f64(y)).unwrap();
    Reflect::set(&obj, &JsValue::from_str("width"), &JsValue::from_f64(width)).unwrap();
    Reflect::set(&obj, &JsValue::from_str("kind"), &JsValue::from_str("image")).unwrap();
    Reflect::set(&obj, &JsValue::from_str("asset"), &JsValue::from(asset)).unwrap();
    obj.into()
}

/// `annotation`, turned by `rotation` degrees.
fn turned_annotation(page: u32, x: f64, y: f64, width: f64, asset: u32, rotation: f64) -> JsValue {
    let obj = annotation(page, x, y, width, asset);
    Reflect::set(&obj, &JsValue::from_str("rotation"), &JsValue::from_f64(rotation)).unwrap();
    obj
}

fn asset_meta(width: u32, height: u32) -> JsValue {
    js_object(&[("width", width), ("height", height)])
}

fn js_uint8_array(items: Vec<Uint8Array>) -> Array {
    let arr = Array::new();
    for item in items {
        arr.push(&item);
    }
    arr
}

#[wasm_bindgen_test]
async fn annotates_a_page_with_an_image() {
    let annotated = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![annotation(1, 0.1, 0.7, 0.3, 0)]),
    )
    .await
    .expect("annotate_pdf should succeed");

    assert!(annotated.length() > 0);
    assert_eq!(expected_page_count(&annotated), 1, "annotating must not change the page count");
    assert_eq!(page_xobject_count(&annotated, 1), 1);
}

/// The point of the asset/placement split: one image on several pages is a
/// single stream in the file, reachable from each of them.
#[wasm_bindgen_test]
async fn one_asset_on_several_pages_is_embedded_once() {
    let annotated = pdfrs::annotate_pdf(
        bytes(FOUR_PAGES),
        js_uint8_array(vec![rgba_square(0, 0, 255, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![
            annotation(1, 0.1, 0.1, 0.2, 0),
            annotation(2, 0.1, 0.1, 0.2, 0),
            annotation(4, 0.1, 0.1, 0.2, 0),
        ]),
    )
    .await
    .expect("annotate_pdf should succeed");

    // One colour image + one /SMask, shared by all three pages.
    assert_eq!(image_stream_count(&annotated), 2);
    for page in [1, 2, 4] {
        assert_eq!(page_xobject_count(&annotated, page), 1, "page {page} should see the image");
        assert_eq!(page_draw_count(&annotated, page), 1, "page {page} should draw it once");
    }
    // Page 3 may *see* the image (these fixtures share one /Resources across
    // every page) but must never draw it.
    assert_eq!(page_draw_count(&annotated, 3), 0, "page 3 was never annotated");
}

#[wasm_bindgen_test]
async fn two_assets_on_one_page() {
    let annotated = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255), rgba_square(0, 255, 0, 128)]),
        js_array(vec![asset_meta(2, 2), asset_meta(2, 2)]),
        js_array(vec![annotation(1, 0.1, 0.1, 0.2, 0), annotation(1, 0.6, 0.6, 0.2, 1)]),
    )
    .await
    .expect("annotate_pdf should succeed");

    assert_eq!(page_xobject_count(&annotated, 1), 2);
    assert_eq!(image_stream_count(&annotated), 4, "two images, each with its own mask");
}

#[wasm_bindgen_test]
async fn annotate_pdf_rejects_an_out_of_range_asset_index() {
    let result = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![annotation(1, 0.1, 0.1, 0.2, 5)]),
    )
    .await;
    assert!(result.is_err(), "an asset index past the end should be rejected");
}

#[wasm_bindgen_test]
async fn annotate_pdf_rejects_a_pixel_buffer_of_the_wrong_length() {
    let result = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![Uint8Array::from(&[0u8, 0, 0, 0][..])]),
        js_array(vec![asset_meta(4, 4)]), // claims 4x4, sends one pixel
        js_array(vec![annotation(1, 0.1, 0.1, 0.2, 0)]),
    )
    .await;
    assert!(result.is_err(), "a mismatched pixel buffer should be rejected");
}

#[wasm_bindgen_test]
async fn annotate_pdf_rejects_a_nonexistent_page() {
    let result = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![annotation(99, 0.1, 0.1, 0.2, 0)]),
    )
    .await;
    assert!(result.is_err(), "annotating a page that doesn't exist should be rejected");
}

#[wasm_bindgen_test]
async fn annotations_can_be_rotated() {
    let annotated = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![turned_annotation(1, 0.3, 0.3, 0.3, 0, 37.5)]),
    )
    .await
    .expect("a rotated annotation should be accepted");

    assert_eq!(page_draw_count(&annotated, 1), 1);
}

/// `rotation` is optional: annotations written before it existed must still
/// work, and must come out identical to an explicit zero.
#[wasm_bindgen_test]
async fn a_missing_rotation_means_upright() {
    let without = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![annotation(1, 0.3, 0.3, 0.3, 0)]),
    )
    .await
    .expect("an annotation without a rotation should be accepted");

    let with_zero = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![turned_annotation(1, 0.3, 0.3, 0.3, 0, 0.0)]),
    )
    .await
    .expect("an explicit zero rotation should be accepted");

    assert_eq!(without.to_vec(), with_zero.to_vec(), "omitting rotation must equal rotation: 0");
}

#[wasm_bindgen_test]
async fn annotate_pdf_rejects_a_rotation_that_is_not_a_number() {
    let result = pdfrs::annotate_pdf(
        bytes(ONE_PAGE),
        js_uint8_array(vec![rgba_square(255, 0, 0, 255)]),
        js_array(vec![asset_meta(2, 2)]),
        js_array(vec![turned_annotation(1, 0.3, 0.3, 0.3, 0, f64::NAN)]),
    )
    .await;
    assert!(result.is_err(), "a NaN rotation should be rejected");
}
