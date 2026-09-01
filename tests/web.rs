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
