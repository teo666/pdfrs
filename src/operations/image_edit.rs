//! Changing the images already in a PDF: putting another picture in the
//! place of one, and recompressing them all to make the file lighter.
//!
//! Both rewrite the image object itself, keeping its object id: every place
//! that draws it (several pages, a Form, a pattern) shows the new one, and
//! the page contents - with their `cm` - stay exactly as they were. An image
//! replaced by one of other proportions is fitted inside the old one's box,
//! the rest left transparent, so nothing on the page has to move.
//!
//! Needs both the `image` crate (encoding) and hayro (decoding every image
//! format a PDF can hold), so it only exists in the "full" build.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::Arc;

use hayro::hayro_interpret::hayro_syntax::Pdf;
use hayro::hayro_interpret::kurbo::{Affine, BezPath, Rect};
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache,
    InterpreterSettings, RenderContent, SoftMask, font::GlyphRun, interpret_page,
};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};

use super::image_extract::to_image;
use super::images::{self, ImageInfo};
use super::nup::{get_page_rotation, get_visible_box};
use crate::error::{PdfrsError, Result};

/// Quality a replacement photo is stored at, when it has to be re-encoded.
const REPLACEMENT_JPEG_QUALITY: u8 = 90;

// --- Replacing an image ------------------------------------------------------

/// Puts the picture `file` (a JPEG or a PNG) in the place of the image `key`
/// (an `ImageInfo::key` from `images::list`), wherever that image is drawn.
/// A picture of other proportions is fitted inside the old one's box,
/// centred, with transparent margins. A JPEG that needs neither turning
/// (EXIF orientation) nor margins goes in byte for byte.
pub fn replace(doc: &mut Document, key: &str, file: &[u8]) -> Result<()> {
    let id = object_id(key)?;
    let (old_width, old_height) = {
        let stream = doc
            .get_object(id)
            .and_then(Object::as_stream)
            .map_err(|_| PdfrsError::InvalidArgument(format!("nessuna immagine {key} nel documento")))?;
        let dict = &stream.dict;
        if dict.get(b"Subtype").and_then(Object::as_name).ok() != Some(b"Image".as_ref()) {
            return Err(PdfrsError::InvalidArgument(format!("l'oggetto {key} non è un'immagine")));
        }
        if dict.get(b"ImageMask").and_then(Object::as_bool).unwrap_or(false) {
            return Err(PdfrsError::InvalidArgument(
                "questa immagine è una maschera (disegna solo una forma col colore corrente): non si può sostituire".into(),
            ));
        }
        let int = |name: &[u8]| dict.get(name).and_then(Object::as_i64).unwrap_or(0);
        (int(b"Width").max(1) as f64, int(b"Height").max(1) as f64)
    };

    let picture = Picture::read(file)?;
    let aspect = old_width / old_height;
    let (width, height) = picture.image.dimensions();
    let fits = ((width as f64 / height as f64) / aspect - 1.0).abs() < 0.01;

    let (stream, mask) = match (&picture.jpeg, fits) {
        // As it is: the JPEG's own bytes.
        (Some(jpeg), true) => (jpeg_stream(jpeg.clone(), width, height, jpeg_is_grey(jpeg)), None),
        _ => {
            let image = if fits { picture.image } else { letterbox(&picture.image, aspect) };
            // A photo stays a JPEG; a PNG (a logo, a drawing) stays lossless.
            encode(&image, picture.jpeg.is_some().then_some(REPLACEMENT_JPEG_QUALITY))?
        }
    };
    write_image(doc, id, stream, mask);
    // An old soft mask nothing points to any more.
    doc.prune_objects();
    Ok(())
}

/// A picture as read from a file: decoded and turned upright, and the file
/// itself when it is a JPEG that may go into the PDF as it is.
struct Picture {
    image: DynamicImage,
    jpeg: Option<Vec<u8>>,
}

impl Picture {
    fn read(file: &[u8]) -> Result<Picture> {
        let unsupported = || PdfrsError::InvalidArgument("formato non supportato: servono un JPEG o un PNG".into());
        let reader = ImageReader::new(Cursor::new(file)).with_guessed_format().map_err(|_| unsupported())?;
        let format = reader.format().ok_or_else(unsupported)?;
        if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png) {
            return Err(unsupported());
        }
        let mut decoder = reader.into_decoder().map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;
        let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
        let mut image = DynamicImage::from_decoder(decoder).map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;
        let upright = orientation == image::metadata::Orientation::NoTransforms;
        image.apply_orientation(orientation);
        // A JPEG the PDF can hold as is: RGB or grey (not CMYK), already upright.
        let jpeg = (format == ImageFormat::Jpeg && upright && matches!(jpeg_components(file), Some(1 | 3)))
            .then(|| file.to_vec());
        Ok(Picture { image, jpeg })
    }
}

/// `image` centred on a transparent canvas of proportions `aspect` (width
/// over height), as small as holds it.
fn letterbox(image: &DynamicImage, aspect: f64) -> DynamicImage {
    let (width, height) = image.dimensions();
    let (canvas_width, canvas_height) = if width as f64 / height as f64 > aspect {
        (width, ((width as f64 / aspect).round() as u32).max(1))
    } else {
        (((height as f64 * aspect).round() as u32).max(1), height)
    };
    let mut canvas = RgbaImage::new(canvas_width, canvas_height);
    let (x, y) = ((canvas_width - width) / 2, (canvas_height - height) / 2);
    image::imageops::overlay(&mut canvas, &image.to_rgba8(), x as i64, y as i64);
    DynamicImage::ImageRgba8(canvas)
}

/// The number of colour components of a JPEG (1 grey, 3 colour, 4 CMYK),
/// from its frame header.
fn jpeg_components(bytes: &[u8]) -> Option<u8> {
    let mut at = 2;
    while at + 4 <= bytes.len() {
        if bytes[at] != 0xFF {
            return None;
        }
        let marker = bytes[at + 1];
        let length = u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]) as usize;
        // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            return bytes.get(at + 9).copied();
        }
        at += 2 + length;
    }
    None
}

fn jpeg_is_grey(bytes: &[u8]) -> bool {
    jpeg_components(bytes) == Some(1)
}

// --- Recompressing -----------------------------------------------------------

/// How much to give up for a lighter file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CompressionLevel {
    /// 220 dpi, JPEG quality 85: hard to tell from the original.
    High,
    /// 150 dpi, quality 75: good on screen and in print.
    #[default]
    Balanced,
    /// 100 dpi, quality 60: for sending, reading on screen.
    Small,
}

impl CompressionLevel {
    fn dpi(self) -> f64 {
        match self {
            CompressionLevel::High => 220.0,
            CompressionLevel::Balanced => 150.0,
            CompressionLevel::Small => 100.0,
        }
    }

    fn quality(self) -> u8 {
        match self {
            CompressionLevel::High => 85,
            CompressionLevel::Balanced => 75,
            CompressionLevel::Small => 60,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompressOptions {
    pub level: CompressionLevel,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompressReport {
    /// Images that could be recompressed (not inline, not black and white scans, not tiny).
    pub considered: usize,
    /// Those that came out lighter, and were put in.
    pub recompressed: usize,
    /// Their stored size (with their soft masks) before and after.
    pub bytes_before: usize,
    pub bytes_after: usize,
}

/// Below this, an image isn't worth decoding again.
const TINY: usize = 8 * 1024;

/// Recompresses the document's images as JPEG, scaled down to what `level`
/// needs at the largest size each is drawn. An image that wouldn't come out
/// at least a tenth lighter is left as it was, as are black and white scans
/// (JBIG2, CCITT, 1 bit: already as small as they get, and blurred by JPEG),
/// masks, inline images and tiny ones. Transparency is kept, as a soft mask.
pub fn compress(bytes: &[u8], options: CompressOptions) -> Result<(Vec<u8>, CompressReport)> {
    let mut doc = Document::load_mem(bytes)?;
    let report = images::list(&doc)?;

    // The size each candidate needs: the largest it's drawn, in pixels at the level's dpi.
    let mut needed: HashMap<ObjectId, (f64, f64)> = HashMap::new();
    let pages = doc.get_pages();
    for placement in &report.placements {
        let Some(info) = report.images.iter().find(|image| image.key == placement.image) else { continue };
        if !worth_trying(&doc, info) {
            continue;
        }
        let Ok(id) = object_id(&info.key) else { continue };
        let Some(&page_id) = pages.get(&placement.page) else { continue };
        let (_, _, box_width, box_height) = get_visible_box(&doc, page_id, placement.page)?;
        let (shown_width, shown_height) = match get_page_rotation(&doc, page_id) {
            90 | 270 => (box_height, box_width),
            _ => (box_width, box_height),
        };
        let inches = |points: f64| points / 72.0;
        let pixels = (
            inches(placement.width * shown_width) * options.level.dpi(),
            inches(placement.height * shown_height) * options.level.dpi(),
        );
        let entry = needed.entry(id).or_insert((0.0, 0.0));
        *entry = (entry.0.max(pixels.0), entry.1.max(pixels.1));
    }

    let mut summary = CompressReport { considered: needed.len(), ..CompressReport::default() };
    if needed.is_empty() {
        return Ok((bytes.to_vec(), summary));
    }

    let decoded = decode_all(bytes, &needed.keys().copied().collect())?;
    for (id, (need_width, need_height)) in needed {
        let Some(image) = decoded.get(&id) else { continue };
        let before = stored_size(&doc, id);
        let (width, height) = image.dimensions();
        // Enough pixels for the larger need, the proportions kept.
        let scale = (need_width / width as f64).max(need_height / height as f64).min(1.0);
        let image = if scale < 0.95 {
            let target = (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1));
            image.resize_exact(target.0, target.1, FilterType::CatmullRom)
        } else {
            image.clone()
        };
        let (stream, mask) = encode(&image, Some(options.level.quality()))?;
        let after = stream.content.len() + mask.as_ref().map_or(0, |mask| mask.content.len());
        if after as f64 > before as f64 * 0.9 {
            continue;
        }
        write_image(&mut doc, id, stream, mask);
        summary.recompressed += 1;
        summary.bytes_before += before;
        summary.bytes_after += after;
    }

    if summary.recompressed > 0 {
        doc.prune_objects();
    }
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(PdfrsError::Save)?;
    Ok((out, summary))
}

fn worth_trying(doc: &Document, info: &ImageInfo) -> bool {
    !info.inline
        && info.bytes >= TINY
        && !matches!(info.format.as_str(), "jbig2" | "ccitt")
        && info.bits_per_component != Some(1)
        && info.color_space.as_deref() != Some("ImageMask")
        && object_id(&info.key).is_ok_and(|id| doc.get_object(id).is_ok())
}

/// An image's stored bytes, its soft mask's included.
fn stored_size(doc: &Document, id: ObjectId) -> usize {
    let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { return 0 };
    let mask = stream
        .dict
        .get(b"SMask")
        .and_then(Object::as_reference)
        .and_then(|mask| doc.get_object(mask))
        .and_then(Object::as_stream)
        .map_or(0, |mask| mask.content.len());
    stream.content.len() + mask
}

/// The images `wanted`, decoded the way the renderer decodes them (every
/// filter and colour space, masks as alpha), each once.
fn decode_all(bytes: &[u8], wanted: &HashSet<ObjectId>) -> Result<HashMap<ObjectId, DynamicImage>> {
    let pdf = Pdf::new(Arc::new(bytes.to_vec())).map_err(|err| PdfrsError::Preview(format!("{err:?}")))?;
    let mut collector = Collector {
        wanted: wanted.iter().map(|&(number, generation)| (number, generation as i32)).collect(),
        images: HashMap::new(),
    };
    let cache = InterpreterCache::new();
    for page in pdf.pages().iter() {
        if collector.images.len() == collector.wanted.len() {
            break;
        }
        let settings = InterpreterSettings { render_content: RenderContent::PAGE, ..InterpreterSettings::default() };
        let (width, height) = page.render_dimensions();
        let mut context =
            Context::new(Affine::IDENTITY, Rect::new(0.0, 0.0, width as f64, height as f64), &cache, page.xref(), settings);
        interpret_page(page, &mut context, &mut collector);
    }
    Ok(collector
        .images
        .into_iter()
        .map(|((number, generation), image)| ((number, generation as u16), image))
        .collect())
}

/// Sits where a renderer would and keeps every wanted image it is sent.
struct Collector {
    wanted: HashSet<(u32, i32)>,
    images: HashMap<(u32, i32), DynamicImage>,
}

impl<'a> Device<'a> for Collector {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph_run(&mut self, _: &GlyphRun<'_, 'a>, _: DrawProps<'a>, _: &DrawMode) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}

    fn draw_image(&mut self, image: Image<'a, '_>, _: ImageDrawProps<'a>) {
        if let Image::Raster(raster) = image {
            let id = raster.stream().obj_id();
            let key = (id.obj_number, id.gen_number);
            if self.wanted.contains(&key) && !self.images.contains_key(&key) {
                raster.with_rgba(
                    |data, alpha| {
                        if let Some(image) = to_image(data, alpha) {
                            self.images.insert(key, image);
                        }
                    },
                    None,
                );
            }
        }
    }
}

// --- Writing an image --------------------------------------------------------

/// `image` as an image stream, and a soft mask stream when it has
/// transparency: the colour as a JPEG at `quality`, or Flate (lossless)
/// without one; the mask always Flate.
fn encode(image: &DynamicImage, quality: Option<u8>) -> Result<(Stream, Option<Stream>)> {
    let (width, height) = image.dimensions();
    let alpha = image.color().has_alpha().then(|| image.to_luma_alpha8());
    let opaque = alpha.as_ref().is_none_or(|la| la.pixels().all(|p| p.0[1] == 255));
    let grey = !image.color().has_color();

    let colour = if grey { DynamicImage::ImageLuma8(image.to_luma8()) } else { DynamicImage::ImageRgb8(image.to_rgb8()) };
    let stream = match quality {
        Some(quality) => {
            let mut jpeg = Vec::new();
            let colour_type = if grey { image::ExtendedColorType::L8 } else { image::ExtendedColorType::Rgb8 };
            JpegEncoder::new_with_quality(&mut jpeg, quality)
                .encode(colour.as_bytes(), width, height, colour_type)
                .map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;
            // What the JPEG actually holds decides the colour space, not what was asked of the encoder.
            let grey = jpeg_is_grey(&jpeg);
            jpeg_stream(jpeg, width, height, grey)
        }
        None => flate_stream(colour.as_bytes().to_vec(), width, height, if grey { "DeviceGray" } else { "DeviceRGB" })?,
    };
    let mask = match (alpha, opaque) {
        (Some(alpha), false) => {
            let values: Vec<u8> = alpha.pixels().map(|p| p.0[1]).collect();
            Some(flate_stream(values, width, height, "DeviceGray")?)
        }
        _ => None,
    };
    Ok((stream, mask))
}

fn jpeg_stream(bytes: Vec<u8>, width: u32, height: u32, grey: bool) -> Stream {
    let mut stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => if grey { "DeviceGray" } else { "DeviceRGB" },
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        },
        bytes,
    );
    // Already compressed: a later Document::compress() must not Flate it on top.
    stream.allows_compression = false;
    stream
}

fn flate_stream(pixels: Vec<u8>, width: u32, height: u32, color_space: &str) -> Result<Stream> {
    let mut stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => color_space,
            "BitsPerComponent" => 8,
        },
        pixels,
    );
    stream.compress().map_err(PdfrsError::from)?;
    stream.allows_compression = false;
    Ok(stream)
}

/// Puts `stream` (with its soft mask) in the place of the object `id`.
fn write_image(doc: &mut Document, id: ObjectId, mut stream: Stream, mask: Option<Stream>) {
    if let Some(mask) = mask {
        let mask_id = doc.add_object(mask);
        stream.dict.set("SMask", mask_id);
    }
    doc.objects.insert(id, Object::Stream(stream));
}

/// `"12 0"` → (12, 0). Inline images have no object to rewrite.
fn object_id(key: &str) -> Result<ObjectId> {
    let mut parts = key.split(' ');
    match (parts.next().and_then(|n| n.parse().ok()), parts.next().and_then(|g| g.parse().ok()), parts.next()) {
        (Some(number), Some(generation), None) => Ok((number, generation)),
        _ => Err(PdfrsError::InvalidArgument(if key.starts_with("inline:") {
            "le immagini scritte dentro la pagina (inline) non si possono sostituire".into()
        } else {
            format!("chiave di immagine non valida: {key}")
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::content_scan::set_page_content;
    use crate::operations::preview::render_page_preview;
    use crate::operations::test_support::multi_page_document;
    use hayro::vello_cpu::Pixmap;
    use image::{GrayImage, Rgb, RgbImage, Rgba};

    /// A photo-like JPEG: smooth colours with some grain, `width`×`height`.
    fn photo(width: u32, height: u32, quality: u8) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, y| {
            let grain = ((x * 7919 + y * 104_729) % 23) as u8;
            Rgb([200u8.saturating_add(grain), (40 + (y * 100 / height)) as u8, (30 + (x * 60 / width)) as u8])
        });
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, quality).encode_image(&image).unwrap();
        jpeg
    }

    fn png(image: DynamicImage) -> Vec<u8> {
        let mut bytes = Vec::new();
        image.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png).unwrap();
        bytes
    }

    /// `pages` A4 pages, each drawing the same image object `stream` in the
    /// box (x, y, width, height), in points. Returns the document and the image's key.
    fn document_with(stream: Stream, pages: u32, placed: (f64, f64, f64, f64)) -> (Document, String) {
        let mut doc = multi_page_document(pages);
        let image_id = doc.add_object(stream);
        let (x, y, width, height) = placed;
        for (_, page_id) in doc.get_pages() {
            let resources = doc.add_object(dictionary! { "XObject" => dictionary! { "Im0" => image_id } });
            doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Resources", resources);
            set_page_content(&mut doc, page_id, format!("q {width} 0 0 {height} {x} {y} cm /Im0 Do Q").into_bytes())
                .unwrap();
        }
        (doc, format!("{} {}", image_id.0, image_id.1))
    }

    fn saved(doc: &mut Document) -> Vec<u8> {
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn image_dict(doc: &Document, key: &str) -> lopdf::Dictionary {
        doc.get_object(object_id(key).unwrap()).unwrap().as_stream().unwrap().dict.clone()
    }

    fn int(dict: &lopdf::Dictionary, name: &[u8]) -> i64 {
        dict.get(name).unwrap().as_i64().unwrap()
    }

    #[test]
    fn a_jpeg_of_the_same_proportions_goes_in_byte_for_byte_on_every_page() {
        let (mut doc, key) = document_with(jpeg_stream(photo(40, 20, 90), 40, 20, false), 2, (100.0, 100.0, 200.0, 100.0));
        let replacement = photo(80, 40, 80);

        replace(&mut doc, &key, &replacement).unwrap();

        let stream = doc.get_object(object_id(&key).unwrap()).unwrap().as_stream().unwrap();
        assert_eq!(stream.content, replacement, "the file's own bytes, not re-encoded");
        assert_eq!((int(&stream.dict, b"Width"), int(&stream.dict, b"Height")), (80, 40));
        // Same object, so both pages draw the new picture.
        let listed = images::list(&doc).unwrap();
        assert_eq!(listed.images.len(), 1);
        assert_eq!(listed.placements.len(), 2);
        assert!(listed.placements.iter().all(|placement| placement.image == key));
    }

    #[test]
    fn a_picture_of_other_proportions_is_fitted_with_transparent_margins() {
        // The old image is 2:1; the new one square.
        let (mut doc, key) = document_with(jpeg_stream(photo(40, 20, 90), 40, 20, false), 1, (100.0, 100.0, 200.0, 100.0));
        let square = png(DynamicImage::ImageRgb8(RgbImage::from_pixel(50, 50, Rgb([0, 0, 255]))));

        replace(&mut doc, &key, &square).unwrap();

        let dict = image_dict(&doc, &key);
        assert_eq!((int(&dict, b"Width"), int(&dict, b"Height")), (100, 50), "the old proportions, the new picture whole");
        assert!(dict.has(b"SMask"), "the margins are transparent");

        // Drawn: blue in the middle of the box, nothing at its left and right ends.
        let png = render_page_preview(&saved(&mut doc), 1, 1.0).unwrap();
        let pixmap = Pixmap::from_png(Cursor::new(png)).unwrap();
        let at = |x: f64, y: f64| {
            let (px, py) = ((x * pixmap.width() as f64) as u16, (y * pixmap.height() as f64) as u16);
            pixmap.sample(px, py)
        };
        // The box spans x 100..300 of 595 points, y 842-200..842-100 from the top.
        let middle_y = (842.0 - 150.0) / 842.0;
        let centre = at(200.0 / 595.0, middle_y);
        assert!(centre.b > 200 && centre.r < 60, "the picture in the middle, got {:?}", centre);
        let left = at(110.0 / 595.0, middle_y);
        assert!(left.r > 240 && left.g > 240 && left.b > 240, "the page showing through the margin, got {:?}", left);
    }

    #[test]
    fn a_transparent_png_keeps_its_transparency() {
        let (mut doc, key) = document_with(jpeg_stream(photo(30, 30, 90), 30, 30, false), 1, (100.0, 100.0, 100.0, 100.0));
        let logo = RgbaImage::from_fn(30, 30, |x, _| if x < 15 { Rgba([255, 0, 0, 255]) } else { Rgba([0, 0, 0, 0]) });

        replace(&mut doc, &key, &png(DynamicImage::ImageRgba8(logo))).unwrap();

        let dict = image_dict(&doc, &key);
        assert_eq!((int(&dict, b"Width"), int(&dict, b"Height")), (30, 30));
        assert_eq!(dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode", "a PNG stays lossless");
        assert!(dict.has(b"SMask"));
    }

    #[test]
    fn the_old_soft_mask_leaves_the_file() {
        let mask = flate_stream(vec![128; 30 * 30], 30, 30, "DeviceGray").unwrap();
        let mut doc = multi_page_document(1);
        let mask_id = doc.add_object(mask);
        let mut stream = jpeg_stream(photo(30, 30, 90), 30, 30, false);
        stream.dict.set("SMask", mask_id);
        let (mut doc, key) = {
            let image_id = doc.add_object(stream);
            let page_id = *doc.get_pages().get(&1).unwrap();
            let resources = doc.add_object(dictionary! { "XObject" => dictionary! { "Im0" => image_id } });
            doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Resources", resources);
            set_page_content(&mut doc, page_id, b"q 100 0 0 100 100 100 cm /Im0 Do Q".to_vec()).unwrap();
            let key = format!("{} {}", image_id.0, image_id.1);
            (doc, key)
        };

        replace(&mut doc, &key, &photo(30, 30, 80)).unwrap();

        assert!(!image_dict(&doc, &key).has(b"SMask"));
        assert!(doc.get_object(mask_id).is_err(), "nothing points to the old mask: gone");
    }

    #[test]
    fn refuses_what_it_cannot_replace() {
        let (mut doc, key) = document_with(jpeg_stream(photo(30, 30, 90), 30, 30, false), 1, (0.0, 0.0, 10.0, 10.0));
        assert!(replace(&mut doc, "inline:5 0#0", &photo(10, 10, 80)).is_err());
        assert!(replace(&mut doc, &key, b"not an image").is_err());
        let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;";
        assert!(replace(&mut doc, &key, gif).is_err(), "only JPEG and PNG");
        let pages_id = doc.get_pages()[&1];
        assert!(replace(&mut doc, &format!("{} 0", pages_id.0), &photo(10, 10, 80)).is_err(), "not an image");
    }

    #[test]
    fn finds_the_components_of_a_jpeg() {
        assert_eq!(jpeg_components(&photo(8, 8, 80)), Some(3));
        let (grey, _) = encode(&DynamicImage::ImageLuma8(GrayImage::new(8, 8)), Some(80)).unwrap();
        assert_eq!(jpeg_components(&grey.content), Some(1), "a grey image makes a grey JPEG");
        assert_eq!(grey.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceGray");
        assert_eq!(jpeg_components(b"nope"), None);
    }

    #[test]
    fn a_large_photo_drawn_small_is_scaled_down_and_recompressed() {
        // 1600×1200 pixels in a 160×120 point box: far more than 150 dpi needs.
        let original = photo(1600, 1200, 95);
        let (mut doc, key) = document_with(jpeg_stream(original.clone(), 1600, 1200, false), 1, (100.0, 500.0, 160.0, 120.0));

        let (bytes, report) = compress(&saved(&mut doc), CompressOptions { level: CompressionLevel::Balanced }).unwrap();

        assert_eq!((report.considered, report.recompressed), (1, 1));
        assert!(report.bytes_after * 3 < report.bytes_before, "much lighter: {:?}", report);
        let out = Document::load_mem(&bytes).unwrap();
        let dict = image_dict(&out, &key);
        // 160 points at 150 dpi: about 333 pixels across.
        assert!((330..=336).contains(&int(&dict, b"Width")), "width {}", int(&dict, b"Width"));
        assert!(bytes.len() < saved(&mut doc).len());

        // Still the same picture where it was.
        let png = render_page_preview(&bytes, 1, 0.5).unwrap();
        let pixmap = Pixmap::from_png(Cursor::new(png)).unwrap();
        let p = pixmap.sample((180.0 / 595.0 * pixmap.width() as f64) as u16, ((842.0 - 560.0) / 842.0 * pixmap.height() as f64) as u16);
        assert!(p.r > 180 && p.g < 160 && p.b < 120, "the photo's reds, got {:?}", p);
    }

    #[test]
    fn the_smaller_level_gives_a_smaller_file() {
        let (mut doc, _) = document_with(jpeg_stream(photo(1600, 1200, 95), 1600, 1200, false), 1, (50.0, 300.0, 480.0, 360.0));
        let bytes = saved(&mut doc);
        let size = |level| compress(&bytes, CompressOptions { level }).unwrap().0.len();
        let (high, balanced, small) = (size(CompressionLevel::High), size(CompressionLevel::Balanced), size(CompressionLevel::Small));
        assert!(high > balanced && balanced > small, "{} > {} > {}", high, balanced, small);
    }

    #[test]
    fn keeps_transparency_and_leaves_alone_what_would_not_get_lighter() {
        // A soft-masked photo, big enough to shrink.
        let mut doc = multi_page_document(1);
        let mask_id = doc.add_object(flate_stream(vec![255; 1200 * 900], 1200, 900, "DeviceGray").unwrap());
        let mut masked = jpeg_stream(photo(1200, 900, 95), 1200, 900, false);
        masked.dict.set("SMask", mask_id);
        // Make the mask half transparent so it has to survive.
        let half: Vec<u8> = (0..1200 * 900).map(|i| if i % 1200 < 600 { 255 } else { 0 }).collect();
        doc.objects.insert(mask_id, Object::Stream(flate_stream(half, 1200, 900, "DeviceGray").unwrap()));
        let masked_id = doc.add_object(masked);
        // A small, already light JPEG: not worth it.
        let small_id = doc.add_object(jpeg_stream(photo(64, 64, 50), 64, 64, false));
        let page_id = *doc.get_pages().get(&1).unwrap();
        let resources =
            doc.add_object(dictionary! { "XObject" => dictionary! { "Im0" => masked_id, "Im1" => small_id } });
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Resources", resources);
        set_page_content(&mut doc, page_id, b"q 120 0 0 90 100 600 cm /Im0 Do Q q 64 0 0 64 300 300 cm /Im1 Do Q".to_vec())
            .unwrap();
        let small_before = doc.get_object(small_id).unwrap().as_stream().unwrap().content.clone();

        let (bytes, report) = compress(&saved(&mut doc), CompressOptions::default()).unwrap();

        assert_eq!(report.recompressed, 1, "{:?}", report);
        let out = Document::load_mem(&bytes).unwrap();
        let masked_out = out.get_object(masked_id).unwrap().as_stream().unwrap();
        assert!(masked_out.dict.has(b"SMask"), "the transparency is kept");
        assert_eq!(out.get_object(small_id).unwrap().as_stream().unwrap().content, small_before, "the small one untouched");
    }

    #[test]
    fn a_document_without_images_comes_back_as_it_was() {
        let mut doc = multi_page_document(2);
        let bytes = saved(&mut doc);
        let (out, report) = compress(&bytes, CompressOptions::default()).unwrap();
        assert_eq!(report, CompressReport::default());
        assert_eq!(out, bytes);
    }
}

#[cfg(test)]
mod photo_page_tests {
    use super::*;
    use crate::operations::image::{image_to_pdf, ImagePageOptions, PageSize};

    /// A photo page as the app makes it (image_to_pdf, on A4): its photo is
    /// found, decoded and recompressed like any other.
    #[test]
    fn recompresses_the_photo_of_a_photo_page() {
        let image = image::RgbImage::from_fn(2000, 1500, |x, y| {
            let grain = ((x * 7919 + y * 104_729) % 61) as u8;
            image::Rgb([150 + grain, 90 + grain / 2, 60])
        });
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 95).encode_image(&image).unwrap();
        let pdf = image_to_pdf(&jpeg, ImagePageOptions { page_size: PageSize::A4, margin: 0.0, ..Default::default() }).unwrap();

        let (out, report) = compress(&pdf, CompressOptions::default()).unwrap();

        assert_eq!(report.considered, 1, "{:?}", report);
        assert_eq!(report.recompressed, 1, "{:?}", report);
        assert!(out.len() < pdf.len());
    }
}
