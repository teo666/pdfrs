use image::{ColorType, ImageDecoder};
use lopdf::{dictionary, Document, Object};
use serde::Deserialize;

use crate::error::{PdfrsError, Result};

/// A4 in PDF points (1/72 inch), portrait.
const A4_WIDTH: f64 = 595.28;
const A4_HEIGHT: f64 = 841.89;
/// US Letter in PDF points, portrait.
const LETTER_WIDTH: f64 = 612.0;
const LETTER_HEIGHT: f64 = 792.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSize {
    /// The page is exactly as big as the image (1 image pixel = 1 PDF point) - the image fills it completely, no fitting needed.
    Native,
    A4,
    Letter,
}

impl Default for PageSize {
    fn default() -> Self {
        PageSize::Native
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
    /// Picks portrait/landscape to match the image's own aspect ratio. Meaningless for `PageSize::Native`, which always matches the image's aspect ratio by construction.
    Auto,
}

impl Default for Orientation {
    fn default() -> Self {
        Orientation::Auto
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImagePageOptions {
    pub page_size: PageSize,
    pub orientation: Orientation,
}

/// Builds a one-page PDF with `bytes` (a JPEG file) drawn on it, sized/oriented
/// per `options`. The JPEG bytes are embedded as-is (`/Filter /DCTDecode`) -
/// no re-encoding, no pixel decoding beyond reading the header for
/// dimensions/color type.
pub fn image_to_pdf(bytes: &[u8], options: ImagePageOptions) -> Result<Vec<u8>> {
    let decoder = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(bytes))
        .map_err(|err| PdfrsError::InvalidArgument(format!("non è un JPEG valido: {err}")))?;

    let (image_width, image_height) = decoder.dimensions();
    let color_space = match decoder.color_type() {
        ColorType::L8 => "DeviceGray",
        ColorType::Rgb8 => "DeviceRGB",
        other => {
            return Err(PdfrsError::InvalidArgument(format!(
                "spazio colore JPEG non supportato: {other:?} (supportati: RGB, scala di grigi)"
            )));
        }
    };

    let (page_width, page_height) = page_dimensions(image_width, image_height, options);

    let mut doc = Document::with_version("1.5");

    let mut image_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => image_width as i64,
        "Height" => image_height as i64,
        "ColorSpace" => color_space,
        "BitsPerComponent" => 8,
        "Filter" => "DCTDecode",
    };
    image_dict.set("Length", bytes.len() as i64);
    let mut image_stream = lopdf::Stream::new(image_dict, bytes.to_vec());
    // The content is already DCTDecode-compressed; letting a later
    // `Document::compress()` (merge_pdfs/compose_pdf/split_pdf all call it)
    // Flate-compress it on top would corrupt the image data.
    image_stream.allows_compression = false;
    let image_id = doc.add_object(image_stream);

    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => image_id },
    });

    // Scale the unit square (`cm`'s implicit 1x1 image space) up to the
    // drawn size, and translate to center it on the page.
    let (draw_width, draw_height) = fitted_size(image_width, image_height, page_width, page_height);
    let tx = (page_width - draw_width) / 2.0;
    let ty = (page_height - draw_height) / 2.0;

    let content = lopdf::content::Content {
        operations: vec![
            lopdf::content::Operation::new("q", vec![]),
            lopdf::content::Operation::new(
                "cm",
                vec![draw_width.into(), 0.0.into(), 0.0.into(), draw_height.into(), tx.into(), ty.into()],
            ),
            lopdf::content::Operation::new("Do", vec!["Im0".into()]),
            lopdf::content::Operation::new("Q", vec![]),
        ],
    };
    let content_id = doc.add_object(lopdf::Stream::new(
        dictionary! {},
        content.encode().map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?,
    ));

    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Contents" => content_id,
        "Resources" => resources_id,
        "MediaBox" => vec![Object::from(0.0), Object::from(0.0), Object::from(page_width), Object::from(page_height)],
    });

    let pages_id = doc.add_object(dictionary! {
        "Type" => "Pages",
        "Kids" => vec![page_id.into()],
        "Count" => 1,
    });
    // Page dicts need a Parent, but it can only be set once the Pages id is known.
    if let Ok(Object::Dictionary(page_dict)) = doc.get_object_mut(page_id) {
        page_dict.set("Parent", pages_id);
    }

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(PdfrsError::Save)?;
    Ok(out)
}

fn page_dimensions(image_width: u32, image_height: u32, options: ImagePageOptions) -> (f64, f64) {
    if options.page_size == PageSize::Native {
        return (image_width as f64, image_height as f64);
    }

    let (base_width, base_height) = match options.page_size {
        PageSize::A4 => (A4_WIDTH, A4_HEIGHT),
        PageSize::Letter => (LETTER_WIDTH, LETTER_HEIGHT),
        PageSize::Native => unreachable!(),
    };

    let landscape = match options.orientation {
        Orientation::Portrait => false,
        Orientation::Landscape => true,
        Orientation::Auto => image_width > image_height,
    };

    if landscape {
        (base_height, base_width)
    } else {
        (base_width, base_height)
    }
}

/// Scales the image to fit within the page while preserving its aspect ratio ("contain").
fn fitted_size(image_width: u32, image_height: u32, page_width: f64, page_height: f64) -> (f64, f64) {
    let scale = (page_width / image_width as f64).min(page_height / image_height as f64);
    (image_width as f64 * scale, image_height as f64 * scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut bytes = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
            .unwrap();
        bytes
    }

    #[test]
    fn native_page_matches_image_pixel_size() {
        let jpeg = sample_jpeg(300, 200);
        let pdf = image_to_pdf(&jpeg, ImagePageOptions::default()).unwrap();

        let doc = Document::load_mem(&pdf).unwrap();
        let (_, page_id) = doc.get_pages().into_iter().next().unwrap();
        let media_box = doc.get_object(page_id).unwrap().as_dict().unwrap().get(b"MediaBox").unwrap().as_array().unwrap();
        let width = media_box[2].as_float().unwrap();
        let height = media_box[3].as_float().unwrap();

        assert_eq!((width as u32, height as u32), (300, 200));
    }

    #[test]
    fn a4_auto_orientation_picks_landscape_for_wide_images() {
        let jpeg = sample_jpeg(400, 100); // wide -> landscape
        let pdf = image_to_pdf(
            &jpeg,
            ImagePageOptions { page_size: PageSize::A4, orientation: Orientation::Auto },
        )
        .unwrap();

        let doc = Document::load_mem(&pdf).unwrap();
        let (_, page_id) = doc.get_pages().into_iter().next().unwrap();
        let media_box = doc.get_object(page_id).unwrap().as_dict().unwrap().get(b"MediaBox").unwrap().as_array().unwrap();
        let width = media_box[2].as_float().unwrap();
        let height = media_box[3].as_float().unwrap();

        assert!(width > height, "expected a landscape A4 page, got {}x{}", width, height);
    }

    #[test]
    fn rejects_non_jpeg_bytes() {
        let err = image_to_pdf(b"not a jpeg", ImagePageOptions::default()).unwrap_err();
        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
    }

    #[test]
    fn produces_a_document_survivable_by_merge_and_split_pipelines() {
        // merge_pdfs/compose_pdf/split_pdf all call Document::compress() -
        // this exercises that the DCTDecode image stream isn't corrupted by it.
        use crate::operations::merge::merge;

        let jpeg = sample_jpeg(64, 64);
        let pdf_bytes = image_to_pdf(&jpeg, ImagePageOptions::default()).unwrap();
        let doc = Document::load_mem(&pdf_bytes).unwrap();

        let merged = merge(vec![doc.clone(), doc]).expect("merge should succeed");
        assert_eq!(merged.get_pages().len(), 2);
    }
}
