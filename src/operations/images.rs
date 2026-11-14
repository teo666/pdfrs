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
use serde::{Deserialize, Serialize};

use super::content_scan::{self, InlineImage, Op, Operand};
use super::nup::{get_inherited_attribute, get_page_rotation, get_visible_box, multiply_matrix};
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
    /// A clipping path is in effect where it's drawn: part of it may not
    /// show, and moved elsewhere it may be cut off.
    pub clipped: bool,
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
    /// A clipping path (`W`, `W*`, or a Form's own box) applies.
    clipped: bool,
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
    clipped_from_outside: bool,
    visiting: &mut Vec<ObjectId>,
    found: &mut dyn FnMut(Draw),
) {
    let mut ctm = start;
    let mut clipped = clipped_from_outside;
    let mut stack = Vec::new();
    let mut occurrence = 0u32;

    for op in content_scan::scan(content) {
        match op.operator.as_str() {
            "q" => stack.push((ctm, clipped)),
            "Q" => (ctm, clipped) = stack.pop().unwrap_or((ctm, clipped)),
            "W" | "W*" => clipped = true,
            "cm" => {
                if let Some(matrix) = matrix_operands(&op) {
                    ctm = multiply_matrix(matrix, ctm);
                }
            }
            "BI" => {
                if let Some(image) = op.inline_image.clone() {
                    found(Draw {
                        source,
                        occurrence,
                        span: op.span.clone(),
                        drawn: Drawn::Inline(image),
                        matrix: ctm,
                        clipped,
                    });
                    occurrence += 1;
                }
            }
            "Do" => {
                let Some(Operand::Name(name)) = op.operands.first() else { continue };
                let Some(id) = xobject_id(doc, resources, name) else { continue };
                let Ok(stream) = doc.get_object(id).and_then(Object::as_stream) else { continue };
                match stream.dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok()) {
                    Some(b"Image") => {
                        found(Draw {
                            source,
                            occurrence,
                            span: op.span.clone(),
                            drawn: Drawn::Object(id),
                            matrix: ctm,
                            clipped,
                        });
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
                            // A Form draws only inside its /BBox.
                            clipped || stream.dict.has(b"BBox"),
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
    walk(doc, &content, resources.as_ref(), IDENTITY, Source::Page(page), 0, false, &mut Vec::new(), &mut |draw| {
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
        // Like the previews: the CropBox, where it lies within the MediaBox.
        let (left, bottom, width, height) = get_visible_box(doc, page_id, page)?;
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
                clipped: draw.clipped,
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

/// Where to put a placement: its new box, in the same frame as
/// `Placement::{x, y, width, height}` (fractions of the page as shown).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMove {
    /// A `Placement::id`.
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The inverse of an affine matrix, if it has one.
fn invert(matrix: [f64; 6]) -> Option<[f64; 6]> {
    let [a, b, c, d, e, f] = matrix;
    let det = a * d - b * c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    Some([ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)])
}

/// A number for a content stream: no exponent, as few digits as it needs.
fn pdf_number(value: f64) -> String {
    let text = format!("{:.6}", if value.abs() < 5e-7 { 0.0 } else { value });
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" { "0".to_string() } else { text.to_string() }
}

/// Moves and resizes the images drawn at the given placements: each one's
/// box (`Placement::{x, y, width, height}`) becomes the one asked for.
///
/// The draw itself is left as it is - wrapped in `q <m> cm … Q`, with `m`
/// what takes the old box onto the new one - so the image keeps whatever it
/// had (mirroring, a turn, the transforms around it), and the placement ids
/// stay the same: a pending removal still finds its image. A draw inside a
/// Form that other pages draw too is refused, since the Form is the same on
/// all of them; one with a box of no size, or a transform that can't be
/// undone, too. Everything is checked before anything changes.
pub fn move_images(doc: &mut Document, moves: &[ImageMove]) -> Result<()> {
    if moves.is_empty() {
        return Ok(());
    }
    for m in moves {
        let values = [m.x, m.y, m.width, m.height];
        if values.iter().any(|v| !v.is_finite()) || m.width <= 0.0 || m.height <= 0.0 {
            return Err(PdfrsError::InvalidArgument(format!("riquadro non valido per l'immagine {}", m.id)));
        }
    }
    let wanted: HashMap<&str, &ImageMove> = moves.iter().map(|m| (m.id.as_str(), m)).collect();
    let report = list(doc)?;
    let pages = doc.get_pages();

    // By stream: the byte ranges to replace, and with what.
    type Replacements = Vec<(Range<usize>, Vec<u8>)>;
    let mut edits: BTreeMap<Source, Replacements> = BTreeMap::new();
    let mut found: BTreeSet<String> = BTreeSet::new();
    for (&page, &page_id) in &pages {
        let display = Display::of(doc, page_id, page)?;
        for draw in page_draws(doc, page, page_id) {
            let id = draw.placement_id();
            let Some(target) = wanted.get(id.as_str()) else { continue };
            if !found.insert(id.clone()) {
                continue;
            }
            let placement = report.placements.iter().find(|p| p.id == id && p.page == page);
            let Some(placement) = placement else { continue };
            if !placement.shared_pages.is_empty() {
                return Err(PdfrsError::InvalidArgument(format!(
                    "l'immagine {id} è disegnata da una Form usata anche dalle pagine {:?}: spostarla la sposterebbe anche lì",
                    placement.shared_pages
                )));
            }
            if placement.width <= 1e-9 || placement.height <= 1e-9 {
                return Err(PdfrsError::InvalidArgument(format!("l'immagine {id} non ha dimensioni da cui partire")));
            }

            // User space -> fractions of the page shown, from three points.
            let origin = display.point(0.0, 0.0);
            let unit_x = display.point(1.0, 0.0);
            let unit_y = display.point(0.0, 1.0);
            let to_display = [
                unit_x[0] - origin[0],
                unit_x[1] - origin[1],
                unit_y[0] - origin[0],
                unit_y[1] - origin[1],
                origin[0],
                origin[1],
            ];
            let from_display = invert(to_display)
                .ok_or_else(|| PdfrsError::InvalidArgument(format!("la pagina {page} ha una misura nulla")))?;
            // The old box onto the new one, in that frame.
            let (sx, sy) = (target.width / placement.width, target.height / placement.height);
            let boxes = [sx, 0.0, 0.0, sy, target.x - placement.x * sx, target.y - placement.y * sy];
            // The same, in user space; then as a `cm` put in front of the draw's own transform.
            let user = multiply_matrix(multiply_matrix(to_display, boxes), from_display);
            let undo = invert(draw.matrix)
                .ok_or_else(|| PdfrsError::InvalidArgument(format!("l'immagine {id} ha una trasformazione degenere")))?;
            let delta = multiply_matrix(multiply_matrix(draw.matrix, user), undo);

            let numbers: Vec<String> = delta.iter().map(|v| pdf_number(*v)).collect();
            let mut with = format!("q {} cm ", numbers.join(" ")).into_bytes();
            let content = match draw.source {
                Source::Page(_) => doc.get_page_content(page_id),
                Source::Form(form) => {
                    let stream = doc.get_object(form)?.as_stream()?;
                    stream.decompressed_content().unwrap_or_else(|_| stream.content.clone())
                }
            };
            with.extend_from_slice(&content[draw.span.clone()]);
            with.extend_from_slice(b" Q");
            edits.entry(draw.source).or_default().push((draw.span, with));
        }
    }
    if let Some(missing) = wanted.keys().find(|id| !found.contains(**id)) {
        return Err(PdfrsError::InvalidArgument(format!("nessuna immagine disegnata in {missing}")));
    }

    for (source, list) in edits {
        match source {
            Source::Page(page) => {
                let page_id = pages[&page];
                let content = content_scan::replace(&doc.get_page_content(page_id), &list);
                content_scan::set_page_content(doc, page_id, content)?;
            }
            Source::Form(id) => {
                let stream = doc.get_object_mut(id)?.as_stream_mut()?;
                let content = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
                stream.set_plain_content(content_scan::replace(&content, &list));
                let _ = stream.compress();
            }
        }
    }
    // The page contents replaced above are now unreachable.
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
            opacity: 1.0,
            layer: stamp::Layer::Over,
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

#[cfg(test)]
mod move_tests {
    use super::tests::{add_image, draw_on};
    use super::*;
    use crate::operations::test_support::multi_page_document;
    use lopdf::{dictionary, Stream};

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4
    }

    fn placed(doc: &Document, id: &str) -> Placement {
        list(doc).unwrap().placements.into_iter().find(|p| p.id == id).expect("still listed, same id")
    }

    fn to(id: &str, x: f64, y: f64, width: f64, height: f64) -> ImageMove {
        ImageMove { id: id.to_string(), x, y, width, height }
    }

    fn assert_box(p: &Placement, x: f64, y: f64, width: f64, height: f64) {
        assert!(
            close(p.x, x) && close(p.y, y) && close(p.width, width) && close(p.height, height),
            "expected ({}, {}, {}, {}), got {:?}",
            x,
            y,
            width,
            height,
            p
        );
    }

    /// A page with the red image at (0.1, 0.1), 0.2 x 0.1 of the page.
    fn page_with_image() -> Document {
        let mut doc = multi_page_document(1);
        let image = add_image(&mut doc, false);
        draw_on(&mut doc, 1, &[("Im0", image)], "q 119 0 0 84.2 59.5 673.6 cm /Im0 Do Q");
        doc
    }

    #[test]
    fn moves_and_resizes_keeping_the_id() {
        let mut doc = page_with_image();
        move_images(&mut doc, &[to("p1#0", 0.5, 0.6, 0.3, 0.2)]).unwrap();
        assert_box(&placed(&doc, "p1#0"), 0.5, 0.6, 0.3, 0.2);

        // Again, from where it is now.
        move_images(&mut doc, &[to("p1#0", 0.0, 0.0, 0.1, 0.05)]).unwrap();
        assert_box(&placed(&doc, "p1#0"), 0.0, 0.0, 0.1, 0.05);
    }

    #[test]
    fn on_a_turned_page_and_a_cropped_one() {
        for edit in ["Rotate", "CropBox"] {
            let mut doc = page_with_image();
            let page_id = doc.get_pages()[&1];
            let page = doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap();
            match edit {
                "Rotate" => page.set("Rotate", 90),
                _ => page.set("CropBox", vec![20.into(), 300.into(), 500.into(), 800.into()]),
            }
            let before = placed(&doc, "p1#0");
            move_images(&mut doc, &[to("p1#0", 0.4, 0.3, before.width * 1.5, before.height * 1.5)]).unwrap();
            let after = placed(&doc, "p1#0");
            assert_box(&after, 0.4, 0.3, before.width * 1.5, before.height * 1.5);
        }
    }

    #[test]
    fn inside_a_form_drawn_by_one_page_only() {
        let mut doc = multi_page_document(2);
        let image = add_image(&mut doc, false);
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
                "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
            },
            b"q 119 0 0 84.2 59.5 673.6 cm /Im0 Do Q".to_vec(),
        ));
        draw_on(&mut doc, 1, &[("Fm0", form)], "q 1 0 0 1 0 0 cm /Fm0 Do Q");
        let id = format!("f{}_{}#0", form.0, form.1);
        assert!(placed(&doc, &id).clipped, "a Form draws only inside its box");

        move_images(&mut doc, &[to(&id, 0.3, 0.3, 0.2, 0.1)]).unwrap();
        assert_box(&placed(&doc, &id), 0.3, 0.3, 0.2, 0.1);

        // Drawn by page 2 too: moving it there would move it here as well.
        let page_two = doc.get_pages()[&2];
        doc.get_object_mut(page_two).unwrap().as_dict_mut().unwrap().set(
            "Resources",
            dictionary! { "XObject" => dictionary! { "Fm0" => form } },
        );
        content_scan::set_page_content(&mut doc, page_two, b"/Fm0 Do".to_vec()).unwrap();
        let err = move_images(&mut doc, &[to(&id, 0.0, 0.0, 0.2, 0.1)]).unwrap_err();
        assert!(err.to_string().contains("Form"), "{}", err);
    }

    #[test]
    fn a_removal_still_finds_a_moved_image() {
        let mut doc = page_with_image();
        let image = add_image(&mut doc, false);
        let page_id = doc.get_pages()[&1];
        let resources = doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().get_mut(b"Resources").unwrap();
        resources.as_dict_mut().unwrap().get_mut(b"XObject").unwrap().as_dict_mut().unwrap().set("Im1", image);
        let content = [doc.get_page_content(page_id), b" q 10 0 0 10 0 0 cm /Im1 Do Q".to_vec()].concat();
        content_scan::set_page_content(&mut doc, page_id, content).unwrap();

        move_images(&mut doc, &[to("p1#0", 0.6, 0.6, 0.2, 0.1)]).unwrap();
        remove(&mut doc, &["p1#1".to_string()]).unwrap();
        let report = list(&doc).unwrap();
        assert_eq!(report.placements.len(), 1);
        assert_box(&report.placements[0], 0.6, 0.6, 0.2, 0.1);
    }

    #[test]
    fn tells_a_clipped_image() {
        let mut doc = multi_page_document(1);
        let image = add_image(&mut doc, false);
        draw_on(&mut doc, 1, &[("Im0", image)], "q 0 0 100 100 re W n q 50 0 0 50 0 0 cm /Im0 Do Q Q q 50 0 0 50 200 200 cm /Im0 Do Q");
        let report = list(&doc).unwrap();
        assert!(report.placements[0].clipped);
        assert!(!report.placements[1].clipped, "the clip ended with its Q");
    }

    #[test]
    fn rejects_what_it_cannot_do() {
        let mut doc = page_with_image();
        assert!(move_images(&mut doc, &[to("p1#9", 0.1, 0.1, 0.1, 0.1)]).is_err());
        assert!(move_images(&mut doc, &[to("p1#0", 0.1, 0.1, 0.0, 0.1)]).is_err());
        assert!(move_images(&mut doc, &[to("p1#0", f64::NAN, 0.1, 0.1, 0.1)]).is_err());
        // Nothing changed.
        assert_box(&placed(&doc, "p1#0"), 0.1, 0.1, 0.2, 0.1);
    }

    #[test]
    fn numbers_without_exponents() {
        assert_eq!(pdf_number(1e-9), "0");
        assert_eq!(pdf_number(-0.0000001), "0");
        assert_eq!(pdf_number(2.5), "2.5");
        assert_eq!(pdf_number(-120.0), "-120");
        assert_eq!(pdf_number(1234567.123456789), "1234567.123457");
    }
}

#[cfg(all(test, feature = "preview"))]
mod move_render_tests {
    use super::tests::{add_image, draw_on};
    use super::*;
    use crate::operations::preview::render_page_preview;
    use crate::operations::test_support::multi_page_document;
    use hayro::vello_cpu::Pixmap;

    fn red_box(doc: &mut Document) -> [f64; 4] {
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let png = render_page_preview(&bytes, 1, 0.5).unwrap();
        let pixmap = Pixmap::from_png(std::io::Cursor::new(png)).unwrap();
        let (w, h) = (pixmap.width(), pixmap.height());
        let (mut left, mut top, mut right, mut bottom) = (u16::MAX, u16::MAX, 0, 0);
        for y in 0..h {
            for x in 0..w {
                let p = pixmap.sample(x, y);
                if p.r > 200 && p.g < 60 && p.b < 60 {
                    left = left.min(x);
                    right = right.max(x);
                    top = top.min(y);
                    bottom = bottom.max(y);
                }
            }
        }
        assert!(right > 0, "the image should show");
        let (w, h) = (w as f64, h as f64);
        [left as f64 / w, top as f64 / h, (right + 1) as f64 / w, (bottom + 1) as f64 / h]
    }

    #[test]
    fn drawn_where_it_was_moved_and_nowhere_else() {
        let mut doc = multi_page_document(1);
        let image = add_image(&mut doc, false);
        draw_on(&mut doc, 1, &[("Im0", image)], "q 119 0 0 84.2 59.5 673.6 cm /Im0 Do Q");
        move_images(&mut doc, &[ImageMove { id: "p1#0".to_string(), x: 0.5, y: 0.7, width: 0.4, height: 0.2 }]).unwrap();

        let [left, top, right, bottom] = red_box(&mut doc);
        let near = |a: f64, b: f64| (a - b).abs() < 0.01;
        assert!(near(left, 0.5) && near(top, 0.7) && near(right, 0.9) && near(bottom, 0.9), "{:?}", [left, top, right, bottom]);
    }
}
