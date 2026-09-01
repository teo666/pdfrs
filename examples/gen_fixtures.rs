//! Regenerates the sample PDFs in `tests/fixtures/`, used by the wasm-bindgen
//! integration tests in `tests/web.rs`. Run with `cargo run --example gen_fixtures`
//! whenever the fixtures need to change.
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

fn multi_page_document(page_count: u32) -> Document {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Courier",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    });
    let content = Content {
        operations: vec![
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec!["F1".into(), 24.into()]),
            Operation::new("Td", vec![72.into(), 720.into()]),
            Operation::new("Tj", vec![Object::string_literal("Test page")]),
            Operation::new("ET", vec![]),
        ],
    };

    let mut kids = Vec::with_capacity(page_count as usize);
    for _ in 0..page_count {
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        });
        kids.push(page_id.into());
    }

    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => page_count,
        }),
    );

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    doc
}

fn main() {
    let out_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    std::fs::create_dir_all(&out_dir).unwrap();

    for (name, pages) in [("one_page.pdf", 1), ("two_pages.pdf", 2), ("four_pages.pdf", 4)] {
        let mut doc = multi_page_document(pages);
        doc.save(out_dir.join(name)).unwrap();
        println!("wrote {}", out_dir.join(name).display());
    }
}
