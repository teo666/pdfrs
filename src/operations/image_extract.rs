//! An image already in a PDF, as a file of its own: to download it, or to
//! show a thumbnail of it.
//!
//! A JPEG the PDF holds as is (RGB or grey, no mask) comes back byte for
//! byte - no loss, no re-encoding. Anything else is decoded the way the
//! preview renderer decodes it (every PDF image format, colour spaces,
//! soft masks) and written as a PNG, transparent where the image is.

use std::io::Cursor;
use std::sync::Arc;

use hayro::hayro_interpret::hayro_syntax::Pdf;
use hayro::hayro_interpret::kurbo::{Affine, BezPath, Rect};
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageData, ImageDrawProps, InterpreterCache,
    InterpreterSettings, LumaData, RenderContent, SoftMask, font::GlyphRun, interpret_page,
};
use image::{DynamicImage, GrayAlphaImage, GrayImage, ImageFormat, RgbImage, RgbaImage};
use lopdf::{Document, Object};
use serde::Serialize;

use super::images;
use crate::error::{PdfrsError, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImage {
    /// `image/jpeg` or `image/png`.
    pub mime: String,
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The image `key` (an `ImageInfo::key` from `images::list`) as a file.
/// `max_size`, if given, caps its longer side: for thumbnails.
pub fn extract(bytes: &[u8], key: &str, max_size: Option<u32>) -> Result<ExtractedImage> {
    let doc = Document::load_mem(bytes)?;
    let (page, draw_index, object) = images::locate(&doc, key)
        .ok_or_else(|| PdfrsError::InvalidArgument(format!("nessuna immagine {key} nel documento")))?;

    if let Some(jpeg) = object.and_then(|id| plain_jpeg(&doc, id, max_size)) {
        return Ok(jpeg);
    }

    let pdf = Pdf::new(Arc::new(bytes.to_vec())).map_err(|err| PdfrsError::Preview(format!("{err:?}")))?;
    let pages = pdf.pages();
    let page = pages.get(page as usize - 1).ok_or(PdfrsError::PageNotFound(page))?;

    let mut grabber = Grabber {
        draw_index,
        object: object.map(|(number, generation)| (number, generation as i32)),
        seen: 0,
        max_size,
        image: None,
    };
    let cache = InterpreterCache::new();
    // The page's own content: annotation appearances aren't the document's images.
    let settings = InterpreterSettings { render_content: RenderContent::PAGE, ..InterpreterSettings::default() };
    let (width, height) = page.render_dimensions();
    let mut context = Context::new(
        Affine::IDENTITY,
        Rect::new(0.0, 0.0, width as f64, height as f64),
        &cache,
        page.xref(),
        settings,
    );
    interpret_page(page, &mut context, &mut grabber);

    let image = grabber
        .image
        .ok_or_else(|| PdfrsError::Preview(format!("l'immagine {key} non si riesce a decodificare")))?;
    let image = match max_size {
        Some(max) if image.width().max(image.height()) > max => {
            let scale = max as f64 / image.width().max(image.height()) as f64;
            image.thumbnail(
                ((image.width() as f64 * scale).round() as u32).max(1),
                ((image.height() as f64 * scale).round() as u32).max(1),
            )
        }
        _ => image,
    };
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|err| PdfrsError::Preview(err.to_string()))?;
    Ok(ExtractedImage { mime: "image/png".to_string(), bytes: png, width: image.width(), height: image.height() })
}

/// The stored bytes, when they already are a JPEG any viewer shows as the
/// PDF does: a single DCT filter, RGB or grey, 8 bits, no mask or decode
/// array. Not for a thumbnail of a larger image (that one is decoded and
/// scaled down instead).
fn plain_jpeg(doc: &Document, id: lopdf::ObjectId, max_size: Option<u32>) -> Option<ExtractedImage> {
    let stream = doc.get_object(id).and_then(Object::as_stream).ok()?;
    let dict = &stream.dict;
    let name = |key: &[u8]| dict.get(key).ok().and_then(|o| o.as_name().ok());
    let int = |key: &[u8]| dict.get(key).ok().and_then(|o| o.as_i64().ok());
    let (width, height) = (int(b"Width")? as u32, int(b"Height")? as u32);
    let simple = name(b"Filter") == Some(b"DCTDecode")
        && matches!(name(b"ColorSpace"), Some(b"DeviceRGB" | b"DeviceGray"))
        && int(b"BitsPerComponent").unwrap_or(8) == 8
        && !dict.has(b"SMask")
        && !dict.has(b"Mask")
        && !dict.has(b"Decode")
        && !dict.has(b"DecodeParms");
    let small_enough = max_size.is_none_or(|max| width.max(height) <= max);
    (simple && small_enough).then(|| ExtractedImage {
        mime: "image/jpeg".to_string(),
        bytes: stream.content.clone(),
        width,
        height,
    })
}

/// Sits where a renderer would and keeps the one image it was sent for:
/// the image object with that id, or (inline) the draw at that index.
struct Grabber {
    draw_index: usize,
    object: Option<(u32, i32)>,
    seen: usize,
    max_size: Option<u32>,
    image: Option<DynamicImage>,
}

impl Grabber {
    fn target(&self, width: u32, height: u32) -> Option<(u32, u32)> {
        let max = self.max_size?;
        let longer = width.max(height).max(1);
        if longer <= max {
            return None;
        }
        let scale = max as f64 / longer as f64;
        Some((((width as f64 * scale) as u32).max(1), ((height as f64 * scale) as u32).max(1)))
    }
}

fn to_image(data: ImageData, alpha: Option<LumaData>) -> Option<DynamicImage> {
    let (width, height) = (data.width(), data.height());
    // A mask of another size than the image is scaled to it.
    let alpha = alpha.map(|mask| {
        let mask = GrayImage::from_raw(mask.width, mask.height, mask.data).unwrap_or_default();
        if mask.dimensions() == (width, height) {
            mask
        } else {
            image::imageops::resize(&mask, width, height, image::imageops::FilterType::Triangle)
        }
    });
    Some(match (data, alpha) {
        (ImageData::Rgb(rgb), None) => DynamicImage::ImageRgb8(RgbImage::from_raw(width, height, rgb.data)?),
        (ImageData::Luma(luma), None) => DynamicImage::ImageLuma8(GrayImage::from_raw(width, height, luma.data)?),
        (ImageData::Rgb(rgb), Some(mask)) => {
            let pixels = rgb.data.chunks_exact(3).zip(mask.as_raw()).flat_map(|(p, a)| [p[0], p[1], p[2], *a]).collect();
            DynamicImage::ImageRgba8(RgbaImage::from_raw(width, height, pixels)?)
        }
        (ImageData::Luma(luma), Some(mask)) => {
            let pixels = luma.data.iter().zip(mask.as_raw()).flat_map(|(l, a)| [*l, *a]).collect();
            DynamicImage::ImageLumaA8(GrayAlphaImage::from_raw(width, height, pixels)?)
        }
    })
}

impl<'a> Device<'a> for Grabber {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph_run(&mut self, _: &GlyphRun<'_, 'a>, _: DrawProps<'a>, _: &DrawMode) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}

    fn draw_image(&mut self, image: Image<'a, '_>, _: ImageDrawProps<'a>) {
        let index = self.seen;
        self.seen += 1;
        if self.image.is_some() {
            return;
        }
        match image {
            Image::Raster(raster) => {
                let id = raster.stream().obj_id();
                let wanted = match self.object {
                    Some((number, generation)) => id.obj_number == number && id.gen_number == generation,
                    None => index == self.draw_index,
                };
                if wanted {
                    let target = self.target(raster.width(), raster.height());
                    raster.with_rgba(|data, alpha| self.image = to_image(data, alpha), target);
                }
            }
            Image::Stencil(stencil) => {
                if self.object.is_none() && index == self.draw_index {
                    let target = self.target(stencil.width(), stencil.height());
                    // A stencil paints where it's set: black there, transparent elsewhere.
                    stencil.with_stencil(
                        |mask, _| {
                            let pixels = mask.data.iter().flat_map(|a| [0, *a]).collect();
                            self.image = GrayAlphaImage::from_raw(mask.width, mask.height, pixels).map(DynamicImage::ImageLumaA8);
                        },
                        target,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::images::tests::{add_image, draw_on};
    use crate::operations::test_support::multi_page_document;
    use lopdf::{Stream, dictionary};

    fn saved(doc: &mut Document) -> Vec<u8> {
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn gives_back_a_plain_jpeg_byte_for_byte() {
        let jpeg = crate::operations::image::tests::sample_jpeg(8, 6);
        let mut doc = multi_page_document(1);
        let id = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 8, "Height" => 6,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Filter" => "DCTDecode" },
            jpeg.clone(),
        ));
        draw_on(&mut doc, 1, &[("Im0", id)], "100 0 0 75 0 0 cm /Im0 Do");
        let bytes = saved(&mut doc);

        let out = extract(&bytes, &format!("{} {}", id.0, id.1), None).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert_eq!(out.bytes, jpeg);
        assert_eq!((out.width, out.height), (8, 6));
    }

    #[test]
    fn decodes_a_masked_image_to_a_png_with_transparency() {
        let mut doc = multi_page_document(1);
        let id = add_image(&mut doc, true);
        draw_on(&mut doc, 1, &[("Im0", id)], "100 0 0 100 0 0 cm /Im0 Do");
        let bytes = saved(&mut doc);

        let out = extract(&bytes, &format!("{} {}", id.0, id.1), None).unwrap();
        assert_eq!(out.mime, "image/png");
        let png = image::load_from_memory(&out.bytes).unwrap().to_rgba8();
        assert_eq!(png.dimensions(), (2, 2));
        // Red, opaque where the mask is 255 and transparent where it's 0.
        assert_eq!(png.get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert_eq!(png.get_pixel(1, 0).0[3], 0);
    }

    #[test]
    fn decodes_an_inline_image_too() {
        let mut doc = multi_page_document(1);
        draw_on(&mut doc, 1, &[], "q 50 0 0 50 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 00FF> EI Q");
        let bytes = saved(&mut doc);

        let out = extract(&bytes, "inline:p1#0", None).unwrap();
        let png = image::load_from_memory(&out.bytes).unwrap().to_luma8();
        assert_eq!(png.as_raw(), &vec![0, 255]);
    }

    #[test]
    fn scales_a_thumbnail_down() {
        let jpeg = crate::operations::image::tests::sample_jpeg(400, 200);
        let mut doc = multi_page_document(1);
        let id = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 400, "Height" => 200,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8, "Filter" => "DCTDecode" },
            jpeg,
        ));
        draw_on(&mut doc, 1, &[("Im0", id)], "200 0 0 100 0 0 cm /Im0 Do");
        let bytes = saved(&mut doc);

        let out = extract(&bytes, &format!("{} {}", id.0, id.1), Some(100)).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!((out.width, out.height), (100, 50));
    }
}
