//! Dev tool: renders every page of a PDF fixture to PNG using `hayro`
//! (the same rasterizer behind `operations::preview::render_page_preview`),
//! so rendering fidelity can be eyeballed without going through wasm.
//! Run with `cargo run --example render_preview [path/to/file.pdf]`.
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{RenderCache, RenderSettings, render};
use std::sync::Arc;

fn main() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let default_path = format!("{manifest_dir}/tests/fixtures/two_pages.pdf");
    let path = std::env::args().nth(1).unwrap_or(default_path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => panic!("reading {}: {}", path, err),
    };

    let pdf = Pdf::new(Arc::new(bytes)).expect("parsing the PDF should succeed");

    let interpreter_settings = InterpreterSettings::default();
    let render_settings = RenderSettings {
        x_scale: 2.0,
        y_scale: 2.0,
        bg_color: WHITE,
        ..Default::default()
    };
    let cache = RenderCache::new();

    for (index, page) in pdf.pages().iter().enumerate() {
        let pixmap = render(page, &cache, &interpreter_settings, &render_settings);
        let out_path = format!("{manifest_dir}/preview-page-{index}.png");
        std::fs::write(&out_path, pixmap.into_png().unwrap()).unwrap();
        println!("wrote {out_path}");
    }
}
