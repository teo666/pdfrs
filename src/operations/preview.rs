use std::sync::Arc;

use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};
use self_cell::self_cell;

use crate::error::{PdfrsError, Result};

self_cell!(
    /// The parsed document and the cache that borrows from it.
    struct Parsed {
        owner: Pdf,

        #[not_covariant]
        dependent: RenderCache,
    }
);

/// A PDF read once and kept, to render many of its pages: the file is parsed
/// (xref, trailer, page tree) only here, and what pages share - fonts, their
/// glyphs, colour spaces, shadings - is decoded on the first page that needs
/// it and reused by the next ones. Decoded images are not kept, so memory
/// doesn't grow with a document full of scans.
///
/// Note: this only accepts already-decrypted PDF bytes (see
/// [`crate::operations::crypto::load_decrypted`]) - `hayro` doesn't need to
/// know about our encryption story since previewing happens after decryption
/// in the same pipeline as every other operation.
pub struct PreviewDocument {
    parsed: Parsed,
}

impl PreviewDocument {
    /// Reads `bytes`, which the document keeps (no copy is made).
    pub fn new(bytes: Vec<u8>) -> Result<Self> {
        let pdf = Pdf::new(Arc::new(bytes)).map_err(|err| PdfrsError::Preview(format!("{err:?}")))?;
        Ok(Self {
            parsed: Parsed::new(pdf, |_| RenderCache::new()),
        })
    }

    pub fn page_count(&self) -> u32 {
        self.parsed.borrow_owner().pages().len() as u32
    }

    /// Renders `page` (1-indexed, matching the rest of this crate's API) to a
    /// PNG image. `scale` multiplies the page's native size (e.g. `1.5` for a
    /// sharper-than-1:1 preview).
    pub fn render_page(&self, page: u32, scale: f32) -> Result<Vec<u8>> {
        // zlib level 3 with the Sub filter: measured on books, datasheets and
        // scans (see `bench`), it encodes ~40% faster than the default
        // (level 6, adaptive filter) for 5-15% bigger files.
        encode_with(&self.draw(page, scale)?, png::DeflateCompression::Level(3), Some(png::Filter::Sub))
    }

    /// The page drawn, before it's encoded.
    fn draw(&self, page: u32, scale: f32) -> Result<hayro::vello_cpu::Pixmap> {
        let index = page.checked_sub(1).ok_or(PdfrsError::PageNotFound(page))? as usize;
        let pixmap = self.parsed.with_dependent(|pdf, cache| {
            let page_obj = pdf.pages().get(index)?;
            Some(render(
                page_obj,
                cache,
                &InterpreterSettings::default(),
                &RenderSettings::default(),
                &PixmapSettings {
                    x_scale: scale,
                    y_scale: scale,
                    bg_color: WHITE,
                },
            ))
        });
        pixmap.ok_or(PdfrsError::PageNotFound(page))
    }
}

/// A drawn page as PNG. RGB, not RGBA: pages are drawn on opaque white, so
/// the alpha channel would be all 255 - a quarter of the bytes to filter
/// and compress for nothing. `filter`: the encoder's adaptive one when absent.
fn encode_with(
    pixmap: &hayro::vello_cpu::Pixmap,
    deflate: png::DeflateCompression,
    filter: Option<png::Filter>,
) -> Result<Vec<u8>> {
    let mut rgb = Vec::with_capacity(pixmap.data().len() * 3);
    for pixel in pixmap.data() {
        rgb.extend_from_slice(&[pixel.r, pixel.g, pixel.b]);
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, pixmap.width() as u32, pixmap.height() as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_deflate_compression(deflate);
    if let Some(filter) = filter {
        encoder.set_filter(filter);
    }
    let error = |err: png::EncodingError| PdfrsError::Preview(format!("{err:?}"));
    let mut writer = encoder.write_header().map_err(error)?;
    writer.write_image_data(&rgb).map_err(error)?;
    writer.finish().map_err(error)?;
    Ok(out)
}

/// Renders one page of a PDF to a PNG image, reading the whole file for it:
/// to render several pages of the same file, [`PreviewDocument`] reads it once.
pub fn render_page_preview(bytes: &[u8], page: u32, scale: f32) -> Result<Vec<u8>> {
    PreviewDocument::new(bytes.to_vec())?.render_page(page, scale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    fn png_bytes_for(page_count: u32) -> Vec<u8> {
        let mut doc = multi_page_document(page_count);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("save should succeed");
        bytes
    }

    #[test]
    fn renders_a_page_to_a_valid_png() {
        let bytes = png_bytes_for(2);

        let png = render_page_preview(&bytes, 1, 1.0).expect("render should succeed");

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "output should start with the PNG magic bytes");
    }

    #[test]
    fn rejects_page_zero() {
        let bytes = png_bytes_for(1);

        let err = render_page_preview(&bytes, 0, 1.0).unwrap_err();

        assert!(matches!(err, PdfrsError::PageNotFound(0)));
    }

    #[test]
    fn rejects_out_of_bounds_page() {
        let bytes = png_bytes_for(1);

        let err = render_page_preview(&bytes, 5, 1.0).unwrap_err();

        assert!(matches!(err, PdfrsError::PageNotFound(5)));
    }

    #[test]
    fn a_kept_document_renders_every_page_as_reading_the_file_anew_would() {
        let bytes = png_bytes_for(3);
        let document = PreviewDocument::new(bytes.clone()).expect("the document should be read");

        assert_eq!(document.page_count(), 3);
        // Out of order and twice, so that the second time the font comes from the cache.
        for page in [3, 1, 2, 1, 3] {
            let kept = document.render_page(page, 0.5).expect("render should succeed");
            let anew = render_page_preview(&bytes, page, 0.5).expect("render should succeed");
            assert!(kept == anew, "page {} differs from the one rendered on its own", page);
        }
    }

    #[test]
    fn a_kept_document_renders_at_any_scale() {
        let document = PreviewDocument::new(png_bytes_for(1)).expect("the document should be read");

        let small = document.render_page(1, 0.25).expect("render should succeed");
        let large = document.render_page(1, 1.0).expect("render should succeed");

        use std::convert::TryInto;
        let width = |png: &[u8]| u32::from_be_bytes(png[16..20].try_into().unwrap());
        assert_eq!(width(&small), 148, "595pt at 0.25, truncated as hayro does");
        assert_eq!(width(&large), 595);
    }

    #[test]
    fn a_kept_document_rejects_pages_it_does_not_have() {
        let document = PreviewDocument::new(png_bytes_for(2)).expect("the document should be read");

        assert!(matches!(document.render_page(0, 1.0), Err(PdfrsError::PageNotFound(0))));
        assert!(matches!(document.render_page(3, 1.0), Err(PdfrsError::PageNotFound(3))));
        // Still usable afterwards.
        assert!(document.render_page(2, 0.5).is_ok());
    }

    #[test]
    fn rejects_bytes_that_are_not_a_pdf() {
        let err = PreviewDocument::new(b"not a pdf".to_vec()).err().expect("should fail");

        assert!(matches!(err, PdfrsError::Preview(_)));
    }

    /// Where a thumbnail's time goes, on a real file:
    ///
    ///   PDFRS_BENCH_PDF=path/to/file.pdf cargo test --release --lib \
    ///     preview::tests::bench -- --ignored --nocapture
    ///
    /// Draws the first `PDFRS_BENCH_PAGES` pages (default 15) at the
    /// thumbnail scale, then encodes each with hayro's own PNG and with a few
    /// compression and filter settings of ours: how long, how big.
    #[test]
    #[ignore = "a measurement on a file of your choice, not a check"]
    fn bench() {
        use std::time::{Duration, Instant};

        let Ok(path) = std::env::var("PDFRS_BENCH_PDF") else {
            eprintln!("PDFRS_BENCH_PDF not set");
            return;
        };
        let bytes = std::fs::read(&path).expect("the file should be readable");
        let pages: u32 = std::env::var("PDFRS_BENCH_PAGES").ok().and_then(|n| n.parse().ok()).unwrap_or(15);
        let scale = 0.4;

        let document = PreviewDocument::new(bytes.clone()).expect("the document should be read");
        let pages = pages.min(document.page_count());
        let mut drawn = Duration::ZERO;
        use png::{DeflateCompression as D, Filter as F};
        let variants: Vec<(&str, Option<(D, F)>)> = vec![
            ("hayro RGBA l6", None),
            ("RGB l6 adapt", Some((D::Level(6), F::Adaptive))),
            ("RGB l1 adapt", Some((D::Level(1), F::Adaptive))),
            ("RGB l1 up", Some((D::Level(1), F::Up))),
            ("RGB l2 up", Some((D::Level(2), F::Up))),
            ("RGB l3 sub", Some((D::Level(3), F::Sub))),
            ("RGB fdef up", Some((D::FdeflateUltraFast, F::Up))),
            ("RGB fdef adapt", Some((D::FdeflateUltraFast, F::Adaptive))),
        ];
        let mut encoded = vec![Duration::ZERO; variants.len()];
        let mut sizes = vec![0usize; variants.len()];
        for page in 1..=pages {
            let start = Instant::now();
            let pixmap = document.draw(page, scale).expect("render should succeed");
            drawn += start.elapsed();
            for (slot, (_, variant)) in variants.iter().enumerate() {
                let start = Instant::now();
                let png = match variant {
                    None => pixmap.clone().into_png().unwrap(),
                    Some((deflate, filter)) => encode_with(&pixmap, *deflate, Some(*filter)).unwrap(),
                };
                encoded[slot] += start.elapsed();
                sizes[slot] += png.len();
            }
        }
        eprintln!("{}: {} pages, drawing {:?}", path, pages, drawn);
        for ((name, _), (time, size)) in variants.iter().zip(encoded.iter().zip(sizes)) {
            eprintln!("  {:<15} encoding {:>10.1?} ({:>3.0}% of drawing), {} KB", name, time, time.as_secs_f64() / drawn.as_secs_f64() * 100.0, size / 1024);
        }
    }

    #[test]
    fn our_png_has_the_very_pixels_hayro_would_give() {
        let document = PreviewDocument::new(png_bytes_for(1)).expect("the document should be read");
        let decode = |png: &[u8]| {
            let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut pixels).unwrap();
            pixels.truncate(info.buffer_size());
            let rgb: Vec<u8> = match info.color_type {
                png::ColorType::Rgba => pixels.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect(),
                _ => pixels,
            };
            (info.width, info.height, rgb)
        };

        let ours = decode(&document.render_page(1, 0.5).unwrap());
        let hayros = decode(&document.draw(1, 0.5).unwrap().into_png().unwrap());
        assert_eq!((ours.0, ours.1), (hayros.0, hayros.1));
        assert!(ours.2 == hayros.2, "the pixels differ");
    }
}
