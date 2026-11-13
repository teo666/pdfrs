//! The images already in a PDF: which ones there are, where each is drawn,
//! and taking some of them away.
//!
//! An image is drawn by `/Name Do` (an image XObject, possibly from inside a
//! Form XObject) or written inline (`BI … EI`). Where it lands is the unit
//! square under the current transform, so finding it means following `q`,
//! `Q` and `cm` through the content - and into Forms, with their `/Matrix`.
//! Content is read and edited with `content_scan`: removing an image cuts
//! exactly its bytes, the rest stays as it was.
//!
//! Positions are given as fractions of the page as shown (the same frame as
//! the previews: CropBox within MediaBox, `/Rotate` applied, origin at the
//! top left), so a UI can draw them over a thumbnail directly. Clipping is
//! not taken into account: a box may reach past the part actually visible.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ops::Range;

use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Serialize;

use super::content_scan::{self, InlineImage, Op, Operand};
use super::nup::{get_inherited_attribute, get_page_box, get_page_rotation, multiply_matrix};
use crate::error::{PdfrsError, Result};

/// Forms nested deeper than this are not followed (and a Form drawing itself never is).
const MAX_FORM_DEPTH: usize = 12;
const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// One distinct image of the document.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    /// `"12 0"` for an image object; `"inline:<stream>#<n>"` for an inline one.
    pub key: String,
    pub width: i64,
    pub height: i64,
    /// `jpeg`, `jpx`, `jbig2`, `ccitt`, `flate`, `lzw`, `rle`, `raw` or `other`.
    pub format: String,
    /// Size of the stored (compressed) data.
    pub bytes: usize,
    pub color_space: Option<String>,
    pub bits_per_component: Option<i64>,
    /// Has a soft mask or a mask: parts of it are transparent.
    pub has_mask: bool,
    pub inline: bool,
}

/// One time an image is drawn on a page.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// What `remove` takes: `"p<page>#<n>"` for the n-th image drawn by the
    /// page's own content, `"f<obj>_<gen>#<n>"` for one drawn by a Form -
    /// the same for every page that draws that Form.
    pub id: String,
    pub page: u32,
    /// The `ImageInfo::key` of what is drawn.
    pub image: String,
    /// Where it lands: the image's top-left, top-right, bottom-right and
    /// bottom-left corners, as fractions of the page shown.
    pub corners: [[f64; 2]; 4],
    /// The box around the corners, same frame.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Other pages drawing the same Form: removing this image removes it there too.
    pub shared_pages: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImagesReport {
    pub images: Vec<ImageInfo>,
    pub placements: Vec<Placement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Source {
    Page(u32),
    Form(ObjectId),
}

impl Source {
    fn key(self) -> String {
        match self {
            Source::Page(page) => format!("p{page}"),
            Source::Form((number, generation)) => format!("f{number}_{generation}"),
        }
    }
}

#[derive(Debug, Clone)]
enum Drawn {
    Object(ObjectId),
    Inline(InlineImage),
}

/// An image draw found while walking a page.
#[derive(Debug, Clone)]
struct Draw {
    source: Source,
    /// Among the image draws of its own content stream (not counting nested Forms).
    occurrence: u32,
    /// Its bytes in that stream's (decompressed) content.
    span: Range<usize>,
    drawn: Drawn,
    /// Image space (unit square) to user space.
    matrix: [f64; 6],
}

impl Draw {
    fn placement_id(&self) -> String {
        format!("{}#{}", self.source.key(), self.occurrence)
    }

    fn image_key(&self) -> String {
        match &self.drawn {
            Drawn::Object((number, generation)) => format!("{number} {generation}"),
            Drawn::Inline(_) => format!("inline:{}", self.placement_id()),
        }
    }
}

fn deref<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    doc.dereference(object).map(|(_, object)| object).unwrap_or(object)
}

fn dict_in<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    dict.get(key).ok().map(|object| deref(doc, object)).and_then(|object| object.as_dict().ok())
}

/// The id of the XObject a resource name stands for.
fn xobject_id(doc: &Document, resources: Option<&Dictionary>, name: &[u8]) -> Option<ObjectId> {
    let xobjects = dict_in(doc, resources?, b"XObject")?;
    xobjects.get(name).ok()?.as_reference().ok()
}

fn name_of(object: &Object) -> Option<String> {
    object.as_name().ok().map(|name| String::from_utf8_lossy(name).into_owned())
}

/// The matrix of a `cm`, if its six operands are numbers.
fn matrix_operands(op: &Op) -> Option<[f64; 6]> {
    if op.operands.len() != 6 {
        return None;
    }
    let mut matrix = [0.0; 6];
    for (slot, operand) in matrix.iter_mut().zip(&op.operands) {
        match operand {
            Operand::Number(n) => *slot = *n,
            _ => return None,
        }
    }
    Some(matrix)
}

fn numbers(doc: &Document, object: &Object) -> Option<Vec<f64>> {
    deref(doc, object)
        .as_array()
        .ok()?
        .iter()
        .map(|value| deref(doc, value).as_float().ok().map(f64::from))
        .collect()
}

/// Walks one content stream, calling `found` for every image it draws -
/// its own, and those of the Forms it draws.
#[allow(clippy::too_many_arguments)]
fn walk(
    doc: &Document,
    content: &[u8],
    resources: Option<&Dictionary>,
    start: [f64; 6],
    source: Source,
    depth: usize,
    visiting: &mut Vec<ObjectId>,
    found: &mut dyn FnMut(Draw),
) {
    let mut ctm = start;
    let mut stack = Vec::new();
    let mut occurrence = 0u32;

    for op in content_scan::scan(content) {
        match op.operator.as_str() {
            "q" => stack.push(ctm),
            "Q" => ctm = stack.pop().unwrap_or(ctm),
            "cm" => {
                if let Some(matrix) = matrix_operands(&op) {
                    ctm = multiply_matrix(matrix, ctm);
                }
            }
            "BI" => {
                if let Some(image) = op.inline_image.clone() {
                    found(Draw { source, occurrence, span: op.span.clone(), drawn: Drawn::Inline(image), matrix: ctm });
                    occurrence += 1;
                }
            }
            "Do" => {
                let Some(Operand::Name(name)) = op.operands.first() else { continue };
                let Some(id) = xobject_id(doc, resources, name) else { continue };
                let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { continue };
                match stream.dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) {
                    Some(b"Image") => {
                        found(Draw { source, occurrence, span: op.span.clone(), drawn: Drawn::Object(id), matrix: ctm });
                        occurrence += 1;
                    }
                    Some(b"Form") if depth < MAX_FORM_DEPTH && !visiting.contains(&id) => {
                        let form_matrix = stream
                            .dict
                            .get(b"Matrix")
                            .ok()
                            .and_then(|m| numbers(doc, m))
                            .and_then(|m| match m[..] {
                                [a, b, c, d, e, f] => Some([a, b, c, d, e, f]),
                                _ => None,
                            })
                            .unwrap_or(IDENTITY);
                        let form_content = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
                        // A Form without its own resources uses those of whoever draws it.
                        let form_resources = dict_in(doc, &stream.dict, b"Resources").or(resources);
                        visiting.push(id);
                        walk(
                            doc,
                            &form_content,
                            form_resources,
                            multiply_matrix(form_matrix, ctm),
                            Source::Form(id),
                            depth + 1,
                            visiting,
                            found,
                        );
                        visiting.pop();
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

fn page_resources(doc: &Document, page_id: ObjectId) -> Option<Dictionary> {
    get_inherited_attribute(doc, page_id, b"Resources").and_then(|object| object.as_dict().ok().cloned())
}

/// Every image draw on a page, in drawing order.
fn page_draws(doc: &Document, page: u32, page_id: ObjectId) -> Vec<Draw> {
    let content = doc.get_page_content(page_id);
    let resources = page_resources(doc, page_id);
    let mut draws = Vec::new();
    walk(doc, &content, resources.as_ref(), IDENTITY, Source::Page(page), 0, &mut Vec::new(), &mut |draw| {
        draws.push(draw)
    });
    draws
}

/// User space to fractions of the page as shown.
struct Display {
    left: f64,
    bottom: f64,
    width: f64,
    height: f64,
    rotation: i64,
}

impl Display {
    fn of(doc: &Document, page_id: ObjectId, page: u32) -> Result<Display> {
        let (mut left, mut bottom, mut width, mut height) = get_page_box(doc, page_id, page)?;
        // Like the previews: the CropBox, where it lies within the MediaBox.
        if let Some(crop) = get_inherited_attribute(doc, page_id, b"CropBox").and_then(|c| numbers(doc, &c)) {
            if let [x0, y0, x1, y1] = crop[..] {
                let (l, r) = (x0.min(x1).max(left), x0.max(x1).min(left + width));
                let (b, t) = (y0.min(y1).max(bottom), y0.max(y1).min(bottom + height));
                if r > l && t > b {
                    (left, bottom, width, height) = (l, b, r - l, t - b);
                }
            }
        }
        Ok(Display { left, bottom, width, height, rotation: get_page_rotation(doc, page_id) })
    }

    fn point(&self, x: f64, y: f64) -> [f64; 2] {
        let u = (x - self.left) / self.width;
        let v = (self.bottom + self.height - y) / self.height;
        match self.rotation {
            90 => [1.0 - v, u],
            180 => [1.0 - u, 1.0 - v],
            270 => [v, 1.0 - u],
            _ => [u, v],
        }
    }
}

fn apply(matrix: [f64; 6], x: f64, y: f64) -> (f64, f64) {
    let [a, b, c, d, e, f] = matrix;
    (a * x + c * y + e, b * x + d * y + f)
}

fn filter_name(doc: &Document, dict: &Dictionary) -> Option<String> {
    let filter = deref(doc, dict.get(b"Filter").ok()?);
    match filter {
        Object::Array(items) => items.last().and_then(|item| name_of(deref(doc, item))),
        other => name_of(other),
    }
}

fn format_of(filter: Option<&str>) -> &'static str {
    match filter {
        None => "raw",
        Some("DCTDecode" | "DCT") => "jpeg",
        Some("JPXDecode") => "jpx",
        Some("JBIG2Decode") => "jbig2",
        Some("CCITTFaxDecode" | "CCF") => "ccitt",
        Some("FlateDecode" | "Fl") => "flate",
        Some("LZWDecode" | "LZW") => "lzw",
        Some("RunLengthDecode" | "RL") => "rle",
        Some(_) => "other",
    }
}

fn color_space_name(doc: &Document, object: &Object) -> Option<String> {
    match deref(doc, object) {
        Object::Array(items) => items.first().and_then(|item| name_of(deref(doc, item))),
        other => name_of(other),
    }
}

fn image_info(doc: &Document, draw: &Draw) -> Option<ImageInfo> {
    let key = draw.image_key();
    match &draw.drawn {
        Drawn::Object(id) => {
            let stream = doc.get_object(*id).and_then(Object::as_stream).ok()?;
            let dict = &stream.dict;
            let int = |key: &[u8]| dict.get(key).ok().and_then(|o| deref(doc, o).as_i64().ok());
            let is_mask = dict.get(b"ImageMask").ok().and_then(|o| o.as_bool().ok()).unwrap_or(false);
            Some(ImageInfo {
                key,
                width: int(b"Width").unwrap_or(0),
                height: int(b"Height").unwrap_or(0),
                format: format_of(filter_name(doc, dict).as_deref()).to_string(),
                bytes: stream.content.len(),
                color_space: if is_mask {
                    Some("ImageMask".to_string())
                } else {
                    dict.get(b"ColorSpace").ok().and_then(|cs| color_space_name(doc, cs))
                },
                bits_per_component: int(b"BitsPerComponent"),
                has_mask: dict.has(b"SMask") || dict.has(b"Mask"),
                inline: false,
            })
        }
        Drawn::Inline(image) => {
            let number = |keys: &[&str]| match image.get(keys) {
                Some(Operand::Number(n)) => Some(*n as i64),
                _ => None,
            };
            let name = |keys: &[&str]| match image.get(keys) {
                Some(Operand::Name(n)) => Some(String::from_utf8_lossy(n).into_owned()),
                _ => None,
            };
            let color_space = name(&["CS", "ColorSpace"]).map(|cs| match cs.as_str() {
                "G" => "DeviceGray".to_string(),
                "RGB" => "DeviceRGB".to_string(),
                "CMYK" => "DeviceCMYK".to_string(),
                "I" => "Indexed".to_string(),
                _ => cs,
            });
            Some(ImageInfo {
                key,
                width: number(&["W", "Width"]).unwrap_or(0),
                height: number(&["H", "Height"]).unwrap_or(0),
                format: format_of(name(&["F", "Filter"]).as_deref()).to_string(),
                bytes: image.data.len(),
                color_space,
                bits_per_component: number(&["BPC", "BitsPerComponent"]),
                has_mask: false,
                inline: true,
            })
        }
    }
}

/// Every image in the document and every place one is drawn.
pub fn list(doc: &Document) -> Result<ImagesReport> {
    let mut report = ImagesReport::default();
    let mut seen = BTreeSet::new();
    let mut form_pages: HashMap<String, BTreeSet<u32>> = HashMap::new();

    for (page, page_id) in doc.get_pages() {
        let display = Display::of(doc, page_id, page)?;
        for draw in page_draws(doc, page, page_id) {
            let key = draw.image_key();
            if seen.insert(key.clone()) {
                if let Some(info) = image_info(doc, &draw) {
                    report.images.push(info);
                }
            }
            if let Source::Form(_) = draw.source {
                form_pages.entry(draw.placement_id()).or_default().insert(page);
            }

            // Image space: (0,1) is the image's top-left corner, (1,0) its bottom-right.
            let corners = [(0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)].map(|(x, y)| {
                let (ux, uy) = apply(draw.matrix, x, y);
                display.point(ux, uy)
            });
            let xs = corners.map(|c| c[0]);
            let ys = corners.map(|c| c[1]);
            let (min_x, max_x) = (xs.iter().cloned().fold(f64::MAX, f64::min), xs.iter().cloned().fold(f64::MIN, f64::max));
            let (min_y, max_y) = (ys.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MIN, f64::max));
            report.placements.push(Placement {
                id: draw.placement_id(),
                page,
                image: key,
                corners,
                x: min_x,
                y: min_y,
                width: max_x - min_x,
                height: max_y - min_y,
                shared_pages: Vec::new(),
            });
        }
    }

    for placement in &mut report.placements {
        if let Some(pages) = form_pages.get(&placement.id) {
            placement.shared_pages = pages.iter().copied().filter(|&p| p != placement.page).collect();
        }
    }
    Ok(report)
}

/// Where an image (an `ImageInfo::key`) is first drawn: the page, its place
/// among the page's image draws in drawing order (Forms included, as a
/// renderer meets them), and its object id unless it is inline.
#[cfg(all(feature = "preview", feature = "image-import"))]
pub(crate) fn locate(doc: &Document, key: &str) -> Option<(u32, usize, Option<ObjectId>)> {
    doc.get_pages().into_iter().find_map(|(page, page_id)| {
        let draws = page_draws(doc, page, page_id);
        let index = draws.iter().position(|draw| draw.image_key() == key)?;
        let object = match draws[index].drawn {
            Drawn::Object(id) => Some(id),
            Drawn::Inline(_) => None,
        };
        Some((page, index, object))
    })
}

/// Takes away the images drawn at `placements` (ids from `list`). An image
/// object nothing draws any more afterwards is deleted from the file; one
/// still drawn elsewhere stays. A page's content is rewritten as a new
/// stream of its own (it may share the old one with other pages); a Form
/// is rewritten in place, since the removal is meant for every page that
/// draws it.
pub fn remove(doc: &mut Document, placements: &[String]) -> Result<()> {
    if placements.is_empty() {
        return Ok(());
    }
    let wanted: BTreeSet<&str> = placements.iter().map(String::as_str).collect();

    // Find every wanted draw, with the byte range to cut in its stream.
    let pages = doc.get_pages();
    let mut cuts: BTreeMap<Source, Vec<Range<usize>>> = BTreeMap::new();
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut touched: BTreeSet<ObjectId> = BTreeSet::new();
    for (&page, &page_id) in &pages {
        for draw in page_draws(doc, page, page_id) {
            let id = draw.placement_id();
            if !wanted.contains(id.as_str()) || !found.insert(id) {
                continue;
            }
            if let Drawn::Object(object) = draw.drawn {
                touched.insert(object);
            }
            cuts.entry(draw.source).or_default().push(draw.span);
        }
    }
    if let Some(missing) = wanted.iter().find(|id| !found.contains(**id)) {
        return Err(PdfrsError::InvalidArgument(format!("nessuna immagine disegnata in {missing}")));
    }

    for (source, ranges) in cuts {
        match source {
            Source::Page(page) => {
                let page_id = pages[&page];
                let content = content_scan::cut(&doc.get_page_content(page_id), &ranges);
                content_scan::set_page_content(doc, page_id, content)?;
            }
            Source::Form(id) => {
                let stream = doc.get_object_mut(id)?.as_stream_mut()?;
                let content = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
                stream.set_plain_content(content_scan::cut(&content, &ranges));
                let _ = stream.compress();
            }
        }
    }

    // Image objects nobody draws any more go, references in resources included.
    let still_drawn: BTreeSet<ObjectId> = pages
        .iter()
        .flat_map(|(&page, &page_id)| page_draws(doc, page, page_id))
        .filter_map(|draw| match draw.drawn {
            Drawn::Object(id) => Some(id),
            Drawn::Inline(_) => None,
        })
        .collect();
    for id in touched.difference(&still_drawn) {
        doc.delete_object(*id);
    }
    // Their masks, and the page contents replaced above, are now unreachable.
    doc.prune_objects();
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::operations::stamp::{self, Annotation, AnnotationKind, ImageAsset};
    use crate::operations::test_support::multi_page_document;
    use lopdf::{Stream, dictionary};

    /// An RGB image object (2x2, red), with a mask when asked.
    pub(crate) fn add_image(doc: &mut Document, masked: bool) -> ObjectId {
        let mut dict = dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 2,
            "Height" => 2,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        };
        if masked {
            let mask = doc.add_object(Stream::new(
                dictionary! { "Type" => "XObject", "Subtype" => "Image", "Width" => 2, "Height" => 2, "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8 },
                vec![255, 0, 255, 0],
            ));
            dict.set("SMask", mask);
        }
        doc.add_object(Stream::new(dict, [255u8, 0, 0].repeat(4)))
    }

    /// Gives `page` its own resources with `names` → `ids` as XObjects, and `content`.
    pub(crate) fn draw_on(doc: &mut Document, page: u32, xobjects: &[(&str, ObjectId)], content: &str) {
        let page_id = doc.get_pages()[&page];
        let mut xobject = Dictionary::new();
        for (name, id) in xobjects {
            xobject.set(*name, *id);
        }
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Resources", dictionary! { "XObject" => xobject });
        content_scan::set_page_content(doc, page_id, content.as_bytes().to_vec()).unwrap();
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn finds_an_image_and_where_it_is_drawn() {
        let mut doc = multi_page_document(1);
        let image = add_image(&mut doc, true);
        // 595 x 842 page; the image 119 x 84.2 at (59.5, 673.6) from the bottom-left.
        draw_on(&mut doc, 1, &[("Im0", image)], "q 119 0 0 84.2 59.5 673.6 cm /Im0 Do Q");

        let report = list(&doc).unwrap();
        assert_eq!(report.images.len(), 1);
        let info = &report.images[0];
        assert_eq!((info.width, info.height, info.format.as_str()), (2, 2, "raw"));
        assert_eq!(info.color_space.as_deref(), Some("DeviceRGB"));
        assert!(info.has_mask && !info.inline);

        let placement = &report.placements[0];
        assert_eq!(placement.id, "p1#0");
        assert_eq!(placement.image, info.key);
        assert!(close(placement.x, 0.1) && close(placement.width, 0.2), "{:?}", placement);
        assert!(close(placement.y, 0.1) && close(placement.height, 0.1), "{:?}", placement);
        // Top-left corner first.
        assert!(close(placement.corners[0][0], 0.1) && close(placement.corners[0][1], 0.1));
    }

    #[test]
    fn follows_forms_inline_images_and_saved_states() {
        let mut doc = multi_page_document(2);
        let image = add_image(&mut doc, false);
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
                "Matrix" => vec![1.into(), 0.into(), 0.into(), 1.into(), 100.into(), 0.into()],
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
            },
            b"q 50 0 0 50 0 0 cm /Im0 Do Q".to_vec(),
        ));
        let content = "q 2 0 0 2 0 0 cm Q 10 0 0 10 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID A EI /Fm0 Do";
        draw_on(&mut doc, 1, &[("Fm0", form)], content);
        draw_on(&mut doc, 2, &[("Fm0", form)], "/Fm0 Do");

        let report = list(&doc).unwrap();
        assert_eq!(report.images.len(), 2, "{:?}", report.images);
        let inline = report.images.iter().find(|i| i.inline).unwrap();
        assert_eq!(inline.color_space.as_deref(), Some("DeviceGray"));

        let on_page_1: Vec<_> = report.placements.iter().filter(|p| p.page == 1).collect();
        assert_eq!(on_page_1.len(), 2);
        // The inline image: 10 x 10 at the origin (the 2x scale was restored by Q).
        assert!(close(on_page_1[0].width, 10.0 / 595.0));
        // The Form's image: its 50 x 50 under the Form matrix (x + 100) and the page's 10x.
        let in_form = on_page_1[1];
        assert_eq!(in_form.id, format!("f{}_{}#0", form.0, form.1));
        assert!(close(in_form.x, 1000.0 / 595.0) && close(in_form.width, 500.0 / 595.0), "{:?}", in_form);
        assert_eq!(in_form.shared_pages, vec![2]);
    }

    #[test]
    fn agrees_with_where_a_stamp_puts_an_image_on_a_turned_page() {
        let mut doc = multi_page_document(1);
        let page_id = doc.get_pages()[&1];
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("Rotate", 90);
        let pixels = [255u8, 0, 0, 255].repeat(4);
        let asset = ImageAsset { pixels: &pixels, width: 2, height: 2 };
        let annotation = Annotation {
            page: 1,
            x: 0.2,
            y: 0.3,
            width: 0.25,
            rotation: 0.0,
            height: None,
            kind: AnnotationKind::Image { asset: 0 },
        };
        stamp::annotate(&mut doc, &[asset], &[annotation]).unwrap();

        let placement = &list(&doc).unwrap().placements[0];
        assert!(close(placement.x, 0.2) && close(placement.y, 0.3), "{:?}", placement);
        assert!(close(placement.width, 0.25), "{:?}", placement);
    }

    #[test]
    fn measures_against_the_crop_box() {
        let mut doc = multi_page_document(1);
        let image = add_image(&mut doc, false);
        draw_on(&mut doc, 1, &[("Im0", image)], "100 0 0 100 100 100 cm /Im0 Do");
        let page_id = doc.get_pages()[&1];
        let crop = vec![100.into(), 100.into(), 300.into(), 300.into()];
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().set("CropBox", crop);

        let placement = &list(&doc).unwrap().placements[0];
        assert!(close(placement.x, 0.0) && close(placement.y, 0.5) && close(placement.width, 0.5), "{:?}", placement);
    }

    #[test]
    fn removes_one_draw_and_keeps_an_image_still_drawn_elsewhere() {
        let mut doc = multi_page_document(2);
        let image = add_image(&mut doc, false);
        draw_on(&mut doc, 1, &[("Im0", image)], "q 10 0 0 10 0 0 cm /Im0 Do Q q 10 0 0 10 50 0 cm /Im0 Do Q");
        draw_on(&mut doc, 2, &[("Im0", image)], "/Im0 Do");

        remove(&mut doc, &["p1#1".to_string()]).unwrap();

        let report = list(&doc).unwrap();
        let ids: Vec<_> = report.placements.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["p1#0", "p2#0"]);
        assert!(doc.get_object(image).is_ok(), "still drawn: kept");
    }

    #[test]
    fn deletes_an_image_nothing_draws_any_more_and_the_file_shrinks() {
        let mut doc = multi_page_document(2);
        let image = add_image(&mut doc, true);
        draw_on(&mut doc, 1, &[("Im0", image)], "/Im0 Do");
        draw_on(&mut doc, 2, &[("Im0", image)], "/Im0 Do");
        let size = |doc: &mut Document| {
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            bytes.len()
        };
        let before = size(&mut doc);

        remove(&mut doc, &["p1#0".to_string(), "p2#0".to_string()]).unwrap();

        assert!(list(&doc).unwrap().images.is_empty());
        assert!(doc.get_object(image).is_err(), "the image object is gone");
        let has_image_stream = doc.objects.values().any(|o| {
            o.as_stream().ok().and_then(|s| s.dict.get(b"Subtype").ok()).and_then(|s| s.as_name().ok()) == Some(b"Image")
        });
        assert!(!has_image_stream, "its mask too");
        assert!(size(&mut doc) < before);
    }

    #[test]
    fn removing_from_a_page_leaves_a_content_stream_it_shares_alone() {
        let mut doc = multi_page_document(2);
        let image = add_image(&mut doc, false);
        draw_on(&mut doc, 1, &[("Im0", image)], "/Im0 Do");
        let pages = doc.get_pages();
        let shared = doc.get_page_contents(pages[&1])[0];
        let resources = doc.get_dictionary(pages[&1]).unwrap().get(b"Resources").unwrap().clone();
        let second = doc.get_object_mut(pages[&2]).unwrap().as_dict_mut().unwrap();
        second.set("Contents", shared);
        second.set("Resources", resources);

        remove(&mut doc, &["p1#0".to_string()]).unwrap();

        let ids: Vec<_> = list(&doc).unwrap().placements.into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["p2#0"]);
    }

    #[test]
    fn removes_an_inline_image_and_leaves_every_other_byte() {
        let mut doc = multi_page_document(1);
        let image = add_image(&mut doc, false);
        let before = "BT /F1 12 Tf (keep me) Tj ET q 9 0 0 9 0 0 cm ";
        let inline = "BI /W 1 /H 1 /CS /G /BPC 8 /F /AHx ID 80> EI";
        let after = " Q /Im0 Do";
        draw_on(&mut doc, 1, &[("Im0", image)], &format!("{before}{inline}{after}"));

        remove(&mut doc, &["p1#0".to_string()]).unwrap();

        let page_id = doc.get_pages()[&1];
        let content = String::from_utf8(doc.get_page_content(page_id)).unwrap();
        assert_eq!(content.trim_end(), format!("{before} {after}"));
        assert_eq!(list(&doc).unwrap().placements[0].id, "p1#0", "the XObject is now the first draw");
    }

    #[test]
    fn removes_inside_a_form_for_every_page_that_draws_it() {
        let mut doc = multi_page_document(2);
        let image = add_image(&mut doc, false);
        let form = doc.add_object(Stream::new(
            dictionary! { "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 1.into(), 1.into()],
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } } },
            b"/Im0 Do".to_vec(),
        ));
        draw_on(&mut doc, 1, &[("Fm0", form)], "/Fm0 Do");
        draw_on(&mut doc, 2, &[("Fm0", form)], "/Fm0 Do");

        remove(&mut doc, &[format!("f{}_{}#0", form.0, form.1)]).unwrap();

        assert!(list(&doc).unwrap().placements.is_empty());
    }

    #[test]
    fn rejects_a_placement_that_does_not_exist() {
        let mut doc = multi_page_document(1);
        assert!(remove(&mut doc, &["p1#0".to_string()]).is_err());
    }
}
