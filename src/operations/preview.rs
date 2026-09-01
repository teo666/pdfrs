use std::sync::Arc;

use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{RenderCache, RenderSettings, render};

use crate::error::{PdfrsError, Result};

/// Renders `page` (1-indexed, matching the rest of this crate's API) of a PDF
/// to a PNG image, for use as a browser preview thumbnail. `scale` multiplies
/// the page's native size (e.g. `1.5` for a sharper-than-1:1 preview).
///
/// Note: this only accepts already-decrypted PDF bytes (see
/// [`crate::operations::crypto::load_decrypted`]) - `hayro` doesn't need to
/// know about our encryption story since previewing happens after decryption
/// in the same pipeline as every other operation.
pub fn render_page_preview(bytes: &[u8], page: u32, scale: f32) -> Result<Vec<u8>> {
    let index = page
        .checked_sub(1)
        .ok_or(PdfrsError::PageNotFound(page))? as usize;

    let pdf = Pdf::new(Arc::new(bytes.to_vec())).map_err(|err| PdfrsError::Preview(format!("{err:?}")))?;
    let pages = pdf.pages();
    let page_obj = pages.get(index).ok_or(PdfrsError::PageNotFound(page))?;

    let cache = RenderCache::new();
    let pixmap = render(
        page_obj,
        &cache,
        &InterpreterSettings::default(),
        &RenderSettings {
            x_scale: scale,
            y_scale: scale,
            bg_color: WHITE,
            ..Default::default()
        },
    );

    pixmap.into_png().map_err(|err| PdfrsError::Preview(format!("{err:?}")))
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
}
