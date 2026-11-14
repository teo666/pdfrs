//! A text watermark across many pages, a blank page, and the size of each
//! page as it's shown.
//!
//! The watermark is built on [`stamp::annotate`]: for every page it works out
//! the text box (size, centre, angle) from that page's own size, then hands
//! the lot over as text annotations. Opacity and "under the content" are
//! annotation features, so they come along for free.

use lopdf::{dictionary, Document, Object, Stream};
use serde::{Deserialize, Serialize};

use super::nup::get_visible_box;
use super::stamp::{self, Annotation, AnnotationKind, Layer};
use super::text::{self, FontFace, StandardFont, TextAlign};
use crate::error::{PdfrsError, Result};

/// How big the watermark's text is.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum WatermarkSize {
    /// A font size, in points: the same on every page.
    Points(f64),
    /// `"fit"`: as big as fits in 80% of each page, at the chosen angle.
    Keyword(SizeKeyword),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SizeKeyword {
    Fit,
}

impl Default for WatermarkSize {
    fn default() -> Self {
        WatermarkSize::Keyword(SizeKeyword::Fit)
    }
}

/// Where the watermark sits on the page as shown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatermarkPosition {
    #[default]
    Center,
    Top,
    Bottom,
}

fn default_opacity() -> f64 {
    0.3
}

fn default_angle() -> f64 {
    45.0
}

fn centred() -> TextAlign {
    TextAlign::Center
}

fn default_color() -> String {
    "#808080".to_string()
}

/// What `watermark` draws, and where.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkOptions {
    /// One or more lines (`\n`), in a PDF standard font (WinAnsi characters).
    pub text: String,
    #[serde(default)]
    pub font: StandardFont,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    /// `#rrggbb`; grey when absent.
    #[serde(default = "default_color")]
    pub color: String,
    /// How the lines line up with each other; centred when absent.
    #[serde(default = "centred")]
    pub align: TextAlign,
    /// 0 to 1; 0.3 when absent.
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub size: WatermarkSize,
    /// Degrees, counter-clockwise as the reader sees the page: 45 (the
    /// default) rises from bottom-left to top-right, 0 is horizontal.
    #[serde(default = "default_angle")]
    pub angle: f64,
    #[serde(default)]
    pub position: WatermarkPosition,
    #[serde(default)]
    pub layer: Layer,
    /// 1-indexed pages to mark; every page when absent.
    #[serde(default)]
    pub pages: Option<Vec<u32>>,
}

/// Share of the page the "fit" size fills, and the margin of top/bottom.
const FIT_SHARE: f64 = 0.8;
const EDGE_MARGIN: f64 = 0.05;

/// Draws the watermark on the chosen pages (all by default), in one pass.
pub fn watermark(doc: &mut Document, options: &WatermarkOptions) -> Result<()> {
    if options.text.trim().is_empty() {
        return Err(PdfrsError::InvalidArgument("il testo della filigrana è vuoto".to_string()));
    }
    if !options.angle.is_finite() {
        return Err(PdfrsError::InvalidArgument(format!("angolo della filigrana non valido: {}", options.angle)));
    }
    if let WatermarkSize::Points(points) = options.size {
        if !points.is_finite() || points <= 0.0 {
            return Err(PdfrsError::InvalidArgument(format!(
                "dimensione della filigrana non valida: {}", points
            )));
        }
    }

    let all = doc.get_pages();
    let pages: Vec<u32> = match &options.pages {
        Some(pages) => {
            let mut pages = pages.clone();
            pages.sort_unstable();
            pages.dedup();
            pages
        }
        None => all.keys().copied().collect(),
    };

    let face = FontFace { family: options.font, bold: options.bold, italic: options.italic };
    let layout = text::layout(&options.text, face);
    let aspect = layout.height / layout.width;
    let radians = options.angle.to_radians();
    let (cos, sin) = (radians.cos().abs(), radians.sin().abs());

    let mut annotations = Vec::with_capacity(pages.len());
    for page in pages {
        let page_id = *all.get(&page).ok_or(PdfrsError::PageNotFound(page))?;
        let (width, height) = shown_size(doc, page_id, page)?;

        // The text box, in points, before it's turned.
        let box_width = match options.size {
            WatermarkSize::Points(points) => layout.width * points,
            // The turned box (w·cos + h·sin by w·sin + h·cos, h = w·aspect)
            // filling FIT_SHARE of the page in whichever direction is tighter.
            WatermarkSize::Keyword(SizeKeyword::Fit) => f64::min(
                FIT_SHARE * width / (cos + aspect * sin),
                FIT_SHARE * height / (sin + aspect * cos),
            ),
        };
        let box_height = box_width * aspect;
        // How tall it stands once turned, for top and bottom.
        let turned_height = box_width * sin + box_height * cos;
        let centre_y = match options.position {
            WatermarkPosition::Center => height / 2.0,
            WatermarkPosition::Top => EDGE_MARGIN * height + turned_height / 2.0,
            WatermarkPosition::Bottom => height - EDGE_MARGIN * height - turned_height / 2.0,
        };

        annotations.push(Annotation {
            page,
            x: (width / 2.0 - box_width / 2.0) / width,
            y: (centre_y - box_height / 2.0) / height,
            width: box_width / width,
            height: None,
            // Annotations turn clockwise; the watermark's angle is counter-clockwise.
            rotation: -options.angle,
            opacity: options.opacity,
            layer: options.layer,
            kind: AnnotationKind::Text {
                text: options.text.clone(),
                font: options.font,
                bold: options.bold,
                italic: options.italic,
                color: options.color.clone(),
                align: options.align,
            },
        });
    }

    stamp::annotate(doc, &[], &annotations)
}

/// A page's size as it's shown, in points: the visible part (CropBox within
/// MediaBox), its sides swapped when `/Rotate` turns it a quarter.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

fn shown_size(doc: &Document, page_id: lopdf::ObjectId, page: u32) -> Result<(f64, f64)> {
    let (_, _, width, height) = get_visible_box(doc, page_id, page)?;
    Ok(match stamp::page_rotation(doc, page_id) {
        90 | 270 => (height, width),
        _ => (width, height),
    })
}

/// Every page's size as it's shown, in page order.
pub fn page_sizes(doc: &Document) -> Result<Vec<PageSize>> {
    doc.get_pages()
        .into_iter()
        .map(|(page, page_id)| shown_size(doc, page_id, page).map(|(width, height)| PageSize { width, height }))
        .collect()
}

/// The largest page side PDF readers have to support (200 inches).
const MAX_SIDE: f64 = 14_400.0;

/// A PDF of one empty page, `width` by `height` points.
pub fn blank_page(width: f64, height: f64) -> Result<Document> {
    for side in [width, height] {
        if !side.is_finite() || side < 1.0 || side > MAX_SIDE {
            return Err(PdfrsError::InvalidArgument(format!(
                "misura della pagina non valida: {} punti (da 1 a {MAX_SIDE})", side
            )));
        }
    }

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.into(), 0.into(), Object::Real(width as f32), Object::Real(height as f32)],
        "Contents" => content_id,
        "Resources" => dictionary! {},
    });
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    pub(super) fn options(text: &str) -> WatermarkOptions {
        WatermarkOptions {
            text: text.to_string(),
            font: StandardFont::Helvetica,
            bold: true,
            italic: false,
            color: "#ff0000".to_string(),
            align: TextAlign::Center,
            opacity: 1.0,
            size: WatermarkSize::default(),
            angle: 0.0,
            position: WatermarkPosition::Center,
            layer: Layer::Over,
            pages: None,
        }
    }

    #[test]
    fn options_read_from_js_with_their_defaults() {
        let read: WatermarkOptions = serde_json::from_str(r#"{ "text": "BOZZA" }"#).unwrap();
        assert_eq!(read.size, WatermarkSize::Keyword(SizeKeyword::Fit));
        assert_eq!((read.opacity, read.angle), (0.3, 45.0));
        assert_eq!(read.align, TextAlign::Center);
        assert_eq!((read.position, read.layer), (WatermarkPosition::Center, Layer::Over));

        let read: WatermarkOptions =
            serde_json::from_str(r#"{ "text": "X", "size": 48, "position": "top", "layer": "under", "pages": [2] }"#)
                .unwrap();
        assert_eq!(read.size, WatermarkSize::Points(48.0));
        assert_eq!((read.position, read.layer), (WatermarkPosition::Top, Layer::Under));
        assert_eq!(read.pages, Some(vec![2]));
    }

    #[test]
    fn marks_only_the_pages_asked_for() {
        let mut doc = multi_page_document(3);
        let pages = doc.get_pages();
        let before: Vec<Vec<u8>> = pages.values().map(|id| doc.get_page_content(*id)).collect();

        watermark(&mut doc, &WatermarkOptions { pages: Some(vec![2, 2]), ..options("BOZZA") }).unwrap();

        let after: Vec<Vec<u8>> = pages.values().map(|id| doc.get_page_content(*id)).collect();
        assert_eq!(after[0], before[0]);
        assert_ne!(after[1], before[1]);
        assert_eq!(after[2], before[2]);
    }

    #[test]
    fn opacity_becomes_a_graphics_state_shared_by_the_pages() {
        let mut doc = multi_page_document(2);
        watermark(&mut doc, &WatermarkOptions { opacity: 0.25, ..options("BOZZA") }).unwrap();

        let states: Vec<_> = doc
            .objects
            .values()
            .filter_map(|object| object.as_dict().ok())
            .filter(|dict| dict.get(b"Type").and_then(Object::as_name).ok() == Some(b"ExtGState".as_ref()))
            .collect();
        assert_eq!(states.len(), 1, "one graphics state for both pages");
        let alpha = states[0].get(b"ca").unwrap().as_float().unwrap();
        assert!((alpha - 0.25).abs() < 1e-6, "ca = {}", alpha);
        let content = String::from_utf8_lossy(&doc.get_page_content(doc.get_pages()[&2])).into_owned();
        assert!(content.contains(" gs"), "{}", content);
    }

    #[test]
    fn under_the_content_comes_before_it() {
        let mut doc = multi_page_document(1);
        let page_id = doc.get_pages()[&1];
        let original = doc.get_page_content(page_id);
        watermark(&mut doc, &WatermarkOptions { layer: Layer::Under, ..options("BOZZA") }).unwrap();

        let content = doc.get_page_content(page_id);
        let original_at = content.windows(original.len()).position(|window| window == original.as_slice()).unwrap();
        let text_at = content.windows(2).position(|window| window == b"BT").unwrap();
        assert!(text_at < original_at, "the watermark's text must come first");
    }

    #[test]
    fn rejects_what_it_cannot_draw() {
        let mut doc = multi_page_document(2);
        assert!(watermark(&mut doc, &options("  ")).is_err());
        assert!(watermark(&mut doc, &WatermarkOptions { pages: Some(vec![3]), ..options("X") }).is_err());
        assert!(watermark(&mut doc, &WatermarkOptions { size: WatermarkSize::Points(0.0), ..options("X") }).is_err());
        assert!(watermark(&mut doc, &WatermarkOptions { opacity: 1.5, ..options("X") }).is_err());
    }

    #[test]
    fn page_sizes_are_as_shown() {
        let mut doc = multi_page_document(3);
        let pages = doc.get_pages();
        doc.get_object_mut(pages[&2]).unwrap().as_dict_mut().unwrap().set("Rotate", 90);
        doc.get_object_mut(pages[&3]).unwrap().as_dict_mut().unwrap().set(
            "CropBox",
            vec![10.into(), 20.into(), 310.into(), 420.into()],
        );

        let sizes = page_sizes(&doc).unwrap();
        assert_eq!(sizes[0], PageSize { width: 595.0, height: 842.0 });
        assert_eq!(sizes[1], PageSize { width: 842.0, height: 595.0 });
        assert_eq!(sizes[2], PageSize { width: 300.0, height: 400.0 });
    }

    #[test]
    fn a_blank_page_of_the_size_asked_for() {
        let mut doc = blank_page(400.0, 300.0).unwrap();
        assert_eq!(doc.get_pages().len(), 1);
        assert_eq!(page_sizes(&doc).unwrap()[0], PageSize { width: 400.0, height: 300.0 });

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(Document::load_mem(&bytes).unwrap().get_pages().len(), 1);

        assert!(blank_page(0.0, 300.0).is_err());
        assert!(blank_page(400.0, f64::NAN).is_err());
        assert!(blank_page(20_000.0, 300.0).is_err());
    }
}

#[cfg(all(test, feature = "preview"))]
mod render_tests {
    use super::tests::options;
    use super::*;
    use crate::operations::preview::render_page_preview;
    use crate::operations::test_support::multi_page_document;
    use hayro::vello_cpu::Pixmap;

    /// The box around the pixels `pick` accepts, in fractions of the image
    /// (left, top, right, bottom), and how many there are.
    fn bounds(png: &[u8], pick: impl Fn(u8, u8, u8) -> bool) -> Option<([f64; 4], usize)> {
        let pixmap = Pixmap::from_png(std::io::Cursor::new(png)).unwrap();
        let (width, height) = (pixmap.width(), pixmap.height());
        let (mut left, mut top, mut right, mut bottom, mut count) = (u16::MAX, u16::MAX, 0, 0, 0);
        for y in 0..height {
            for x in 0..width {
                let pixel = pixmap.sample(x, y);
                if pick(pixel.r, pixel.g, pixel.b) {
                    left = left.min(x);
                    right = right.max(x);
                    top = top.min(y);
                    bottom = bottom.max(y);
                    count += 1;
                }
            }
        }
        (count > 0).then(|| {
            let (w, h) = (width as f64, height as f64);
            ([left as f64 / w, top as f64 / h, (right + 1) as f64 / w, (bottom + 1) as f64 / h], count)
        })
    }

    fn red(r: u8, g: u8, b: u8) -> bool {
        r > 150 && g < 100 && b < 100
    }

    fn render(doc: &mut Document, page: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        render_page_preview(&bytes, page, 0.5).unwrap()
    }

    fn centre([left, top, right, bottom]: [f64; 4]) -> (f64, f64) {
        ((left + right) / 2.0, (top + bottom) / 2.0)
    }

    #[test]
    fn fits_the_page_in_the_middle() {
        let mut doc = multi_page_document(1);
        watermark(&mut doc, &options("BOZZA")).unwrap();

        let (bounds, _) = bounds(&render(&mut doc, 1), red).expect("the watermark should show");
        let (x, y) = centre(bounds);
        assert!((x - 0.5).abs() < 0.03 && (y - 0.5).abs() < 0.03, "{:?}", bounds);
        let width = bounds[2] - bounds[0];
        assert!(width > 0.65 && width <= 0.81, "fit fills about 80% of the width: {:?}", bounds);
    }

    #[test]
    fn on_the_diagonal_it_stays_inside_the_page() {
        let mut doc = multi_page_document(1);
        watermark(&mut doc, &WatermarkOptions { angle: 45.0, ..options("BOZZA") }).unwrap();

        let (bounds, _) = bounds(&render(&mut doc, 1), red).unwrap();
        assert!(bounds[0] > 0.05 && bounds[1] > 0.05 && bounds[2] < 0.95 && bounds[3] < 0.95, "{:?}", bounds);
        // Rising: taller than a horizontal line of text would be.
        assert!(bounds[3] - bounds[1] > 0.3, "{:?}", bounds);
    }

    #[test]
    fn at_the_top_and_at_the_bottom() {
        for (position, inside) in [(WatermarkPosition::Top, 0.0..0.25), (WatermarkPosition::Bottom, 0.75..1.0)] {
            let mut doc = multi_page_document(1);
            watermark(&mut doc, &WatermarkOptions { position, size: WatermarkSize::Points(40.0), ..options("BOZZA") })
                .unwrap();
            let (bounds, _) = bounds(&render(&mut doc, 1), red).unwrap();
            assert!(inside.contains(&bounds[1]) && inside.contains(&bounds[3]), "{:?}: {:?}", position, bounds);
        }
    }

    #[test]
    fn see_through_with_a_low_opacity() {
        let mut doc = multi_page_document(1);
        watermark(&mut doc, &WatermarkOptions { opacity: 0.3, ..options("BOZZA") }).unwrap();
        let png = render(&mut doc, 1);

        assert!(bounds(&png, red).is_none(), "no full red at 30%");
        // Red at 30% over white: (255, ~178, ~178).
        let pink = |r: u8, g: u8, b: u8| r > 240 && (150..215).contains(&g) && (150..215).contains(&b);
        assert!(bounds(&png, pink).is_some(), "a light red should show");
    }

    #[test]
    fn under_the_content_a_filled_page_hides_it() {
        let mut doc = multi_page_document(1);
        let page_id = doc.get_pages()[&1];
        // The whole page painted black, as a scan would cover it.
        let content_id = doc.add_object(Stream::new(dictionary! {}, b"0 0 0 rg 0 0 595 842 re f".to_vec()));
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Contents", content_id);

        let mut under = doc.clone();
        watermark(&mut under, &WatermarkOptions { layer: Layer::Under, ..options("BOZZA") }).unwrap();
        assert!(bounds(&render(&mut under, 1), red).is_none(), "hidden under the black");

        watermark(&mut doc, &options("BOZZA")).unwrap();
        assert!(bounds(&render(&mut doc, 1), red).is_some(), "over it, it shows");
    }

    #[test]
    fn upright_and_centred_on_a_turned_page() {
        let mut doc = multi_page_document(1);
        let page_id = doc.get_pages()[&1];
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Rotate", 90);
        watermark(&mut doc, &options("BOZZA")).unwrap();

        let (bounds, _) = bounds(&render(&mut doc, 1), red).unwrap();
        let (x, y) = centre(bounds);
        assert!((x - 0.5).abs() < 0.03 && (y - 0.5).abs() < 0.03, "{:?}", bounds);
        // Horizontal as the reader sees it: much wider than tall.
        assert!(bounds[2] - bounds[0] > 3.0 * (bounds[3] - bounds[1]), "{:?}", bounds);
    }

    #[test]
    fn centred_on_the_part_of_the_page_shown() {
        let mut doc = multi_page_document(1);
        let page_id = doc.get_pages()[&1];
        doc.get_object_mut(page_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("CropBox", vec![0.into(), 421.into(), 595.into(), 842.into()]);
        watermark(&mut doc, &options("BOZZA")).unwrap();

        let (bounds, _) = bounds(&render(&mut doc, 1), red).unwrap();
        let (x, y) = centre(bounds);
        assert!((x - 0.5).abs() < 0.03 && (y - 0.5).abs() < 0.03, "{:?}", bounds);
    }
}
