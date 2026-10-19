use lopdf::content::Operation;
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

use crate::error::{PdfrsError, Result};

/// Standard paper sizes in PDF points (1/72 inch).
pub const A3_WIDTH: f64 = 841.89;
pub const A3_HEIGHT: f64 = 1190.55;
pub const A4_WIDTH: f64 = 595.28;
pub const A4_HEIGHT: f64 = 841.89;
pub const A5_WIDTH: f64 = 419.53;
pub const A5_HEIGHT: f64 = 595.28;
pub const LETTER_WIDTH: f64 = 612.0;
pub const LETTER_HEIGHT: f64 = 792.0;
pub const LEGAL_WIDTH: f64 = 612.0;
pub const LEGAL_HEIGHT: f64 = 1008.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageSize {
    A3,
    A4,
    A5,
    Letter,
    Legal,
    /// Uses the dimensions of the first source page.
    Native,
}

impl Default for PageSize {
    fn default() -> Self {
        PageSize::A4
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
    /// Automatically selects portrait or landscape based on the layout grid.
    Auto,
}

impl Default for Orientation {
    fn default() -> Self {
        Orientation::Auto
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum NUpLayout {
    /// Preset number of pages per sheet: 1, 2, 4, 6, 8, 9, 16.
    Preset(u32),
    /// Explicit grid: `rows` and `cols`.
    Grid { rows: u32, cols: u32 },
}

impl Default for NUpLayout {
    fn default() -> Self {
        NUpLayout::Preset(2)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowDirection {
    /// Left-to-right, then top-to-bottom (1 2 / 3 4).
    Horizontal,
    /// Top-to-bottom, then left-to-right (1 3 / 2 4).
    Vertical,
}

impl Default for FlowDirection {
    fn default() -> Self {
        FlowDirection::Horizontal
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NUpOptions {
    pub page_size: PageSize,
    pub orientation: Orientation,
    pub layout: NUpLayout,
    pub direction: FlowDirection,
    /// Outer margin of the sheet in PDF points (default: 15.0 pt).
    pub margin: f64,
    /// Spacing between subpage cells in PDF points (default: 10.0 pt).
    pub spacing: f64,
    /// Whether to draw a thin border around each subpage.
    pub draw_borders: bool,
    /// Whether to rotate subpages 90° if it yields a larger rendering scale.
    pub auto_rotate: bool,
}

impl Default for NUpOptions {
    fn default() -> Self {
        Self {
            page_size: PageSize::A4,
            orientation: Orientation::Auto,
            layout: NUpLayout::Preset(2),
            direction: FlowDirection::Horizontal,
            margin: 15.0,
            spacing: 10.0,
            draw_borders: false,
            auto_rotate: true,
        }
    }
}

/// Metadata extracted from a source page to turn it into a Form XObject.
pub(crate) struct SourcePageInfo {
    pub form_id: ObjectId,
    pub media_x: f64,
    pub media_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: i64,
}

/// Rearranges the pages of `doc` into an N-up layout on newly generated sheets.
pub fn nup(doc: &Document, options: NUpOptions) -> Result<Document> {
    let source_pages = doc.get_pages();
    if source_pages.is_empty() {
        return Err(PdfrsError::InvalidArgument("il documento non contiene pagine".to_string()));
    }

    // Clone the source document so we keep all existing resources (fonts, images, forms).
    let mut out_doc = doc.clone();

    // 1. Convert all source pages to Form XObjects
    let mut pages_info = Vec::with_capacity(source_pages.len());
    for (page_num, page_id) in source_pages.iter() {
        let info = create_page_form_xobject(&mut out_doc, *page_id, *page_num)?;
        pages_info.push(info);
    }

    // 2. Determine target sheet dimensions and grid configuration
    let first_page = &pages_info[0];
    let (cols, rows, sheet_width, sheet_height) = resolve_grid_and_sheet_size(
        options.layout,
        options.page_size,
        options.orientation,
        first_page.width,
        first_page.height,
    )?;

    let pages_per_sheet = (cols * rows) as usize;
    let total_sheets = (pages_info.len() + pages_per_sheet - 1) / pages_per_sheet;

    let margin = options.margin.max(0.0);
    let spacing = options.spacing.max(0.0);

    let usable_w = (sheet_width - 2.0 * margin - (cols - 1) as f64 * spacing).max(1.0);
    let usable_h = (sheet_height - 2.0 * margin - (rows - 1) as f64 * spacing).max(1.0);

    let cell_w = usable_w / cols as f64;
    let cell_h = usable_h / rows as f64;

    // 3. Build the new Pages catalog root
    let pages_id = out_doc.new_object_id();
    let mut new_page_ids = Vec::with_capacity(total_sheets);

    for sheet_idx in 0..total_sheets {
        let mut sheet_content_ops: Vec<Operation> = Vec::new();
        let mut sheet_xobjects = lopdf::Dictionary::new();

        for slot_idx in 0..pages_per_sheet {
            let page_idx = sheet_idx * pages_per_sheet + slot_idx;
            if page_idx >= pages_info.len() {
                break;
            }

            let page_info = &pages_info[page_idx];

            // Determine (col, row) within the grid based on FlowDirection
            let (c, r) = match options.direction {
                FlowDirection::Horizontal => {
                    let c = (slot_idx as u32) % cols;
                    let r = (slot_idx as u32) / cols;
                    (c, r)
                }
                FlowDirection::Vertical => {
                    let r = (slot_idx as u32) % rows;
                    let c = (slot_idx as u32) / rows;
                    (c, r)
                }
            };

            let cell_x = margin + c as f64 * (cell_w + spacing);
            let cell_y = margin + (rows - 1 - r) as f64 * (cell_h + spacing);

            let res_name = format!("Fm{}", page_idx);
            sheet_xobjects.set(res_name.clone(), Object::Reference(page_info.form_id));

            render_subpage_in_cell(
                &mut sheet_content_ops,
                page_info,
                &res_name,
                cell_x,
                cell_y,
                cell_w,
                cell_h,
                options.auto_rotate,
                options.draw_borders,
            );
        }

        let content_bytes = lopdf::content::Content {
            operations: sheet_content_ops,
        }
        .encode()
        .map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;

        let mut content_stream = Stream::new(dictionary! {}, content_bytes);
        content_stream.compress().map_err(PdfrsError::from)?;
        let content_id = out_doc.add_object(content_stream);

        let resources_id = out_doc.add_object(dictionary! {
            "XObject" => sheet_xobjects,
        });

        let page_dict = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![
                Object::Real(0.0),
                Object::Real(0.0),
                Object::Real(sheet_width as f32),
                Object::Real(sheet_height as f32),
            ],
            "Contents" => content_id,
            "Resources" => resources_id,
        };

        let new_page_id = out_doc.add_object(page_dict);
        new_page_ids.push(new_page_id);
    }

    // Replace document Catalog and Pages root
    let catalog_id = out_doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .unwrap_or_else(|_| out_doc.new_object_id());

    out_doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => new_page_ids.iter().map(|id| Object::Reference(*id)).collect::<Vec<_>>(),
            "Count" => new_page_ids.len() as u32,
        }),
    );

    let mut catalog_dict = out_doc
        .get_dictionary(catalog_id)
        .cloned()
        .unwrap_or_default();
    catalog_dict.set("Type", "Catalog");
    catalog_dict.set("Pages", pages_id);
    catalog_dict.remove(b"Outlines");
    out_doc.objects.insert(catalog_id, Object::Dictionary(catalog_dict));
    out_doc.trailer.set("Root", catalog_id);

    // Delete old unreferenced Page objects to keep document clean
    for (_, old_page_id) in source_pages {
        out_doc.objects.remove(&old_page_id);
    }

    out_doc.renumber_objects();
    out_doc.compress();

    Ok(out_doc)
}

/// Converts an existing page object into a reusable Form XObject stream.
pub(crate) fn create_page_form_xobject(
    doc: &mut Document,
    page_id: ObjectId,
    page_num: u32,
) -> Result<SourcePageInfo> {
    let (media_x, media_y, width, height) = get_page_box(doc, page_id, page_num)?;
    let rotation = get_page_rotation(doc, page_id);

    // Gather page resources (materializing inherited ones if needed)
    let resources = get_page_resources_dict(doc, page_id)?;

    // Get the page content stream decoded operations
    let content_ops = doc.get_and_decode_page_content(page_id).unwrap_or_else(|_| {
        lopdf::content::Content { operations: vec![] }
    });

    // Wrap the operations in q ... Q to isolate the graphics state
    let mut wrapped_ops = Vec::with_capacity(content_ops.operations.len() + 2);
    wrapped_ops.push(Operation::new("q", vec![]));
    wrapped_ops.extend(content_ops.operations);
    wrapped_ops.push(Operation::new("Q", vec![]));

    let encoded_content = lopdf::content::Content { operations: wrapped_ops }
        .encode()
        .map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;

    let mut form_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Form",
        "FormType" => 1,
        "BBox" => vec![
            Object::Real(media_x as f32),
            Object::Real(media_y as f32),
            Object::Real((media_x + width) as f32),
            Object::Real((media_y + height) as f32),
        ],
    };

    if let Some(res) = resources {
        form_dict.set("Resources", res);
    }

    let mut form_stream = Stream::new(form_dict, encoded_content);
    form_stream.compress().map_err(PdfrsError::from)?;
    let form_id = doc.add_object(form_stream);

    Ok(SourcePageInfo {
        form_id,
        media_x,
        media_y,
        width,
        height,
        rotation,
    })
}

/// Emits drawing operations to position, scale, and draw a subpage inside a target cell.
pub(crate) fn render_subpage_in_cell(
    ops: &mut Vec<Operation>,
    page_info: &SourcePageInfo,
    res_name: &str,
    cell_x: f64,
    cell_y: f64,
    cell_w: f64,
    cell_h: f64,
    auto_rotate: bool,
    draw_borders: bool,
) {
    let rotation = page_info.rotation;
    let (disp_w, disp_h) = match rotation {
        90 | 270 => (page_info.height, page_info.width),
        _ => (page_info.width, page_info.height),
    };

    // Calculate scale factor upright vs rotated 90
    let scale_upright = (cell_w / disp_w).min(cell_h / disp_h);
    let scale_rotated = (cell_w / disp_h).min(cell_h / disp_w);

    let (scale, extra_rotation, eff_w, eff_h) = if auto_rotate && scale_rotated > scale_upright * 1.05 {
        (scale_rotated, 90, disp_h, disp_w)
    } else {
        (scale_upright, 0, disp_w, disp_h)
    };

    let draw_w = eff_w * scale;
    let draw_h = eff_h * scale;

    // Center within the cell
    let offset_x = cell_x + (cell_w - draw_w) / 2.0;
    let offset_y = cell_y + (cell_h - draw_h) / 2.0;

    // Build transformation matrix
    let matrix = compute_subpage_matrix(
        page_info.media_x,
        page_info.media_y,
        page_info.width,
        page_info.height,
        rotation,
        extra_rotation,
        scale,
        offset_x,
        offset_y,
        draw_w,
        draw_h,
    );

    // Draw subpage
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "cm",
        matrix.iter().map(|v| Object::Real(*v as f32)).collect::<Vec<_>>(),
    ));
    ops.push(Operation::new("Do", vec![Object::Name(res_name.as_bytes().to_vec())]));
    ops.push(Operation::new("Q", vec![]));

    // Draw border if requested
    if draw_borders {
        ops.push(Operation::new("q", vec![]));
        ops.push(Operation::new("w", vec![Object::Real(0.5)]));
        ops.push(Operation::new(
            "RG",
            vec![Object::Real(0.6), Object::Real(0.6), Object::Real(0.6)],
        ));
        ops.push(Operation::new(
            "re",
            vec![
                Object::Real(offset_x as f32),
                Object::Real(offset_y as f32),
                Object::Real(draw_w as f32),
                Object::Real(draw_h as f32),
            ],
        ));
        ops.push(Operation::new("S", vec![]));
        ops.push(Operation::new("Q", vec![]));
    }
}

/// Resolves the grid dimensions `(cols, rows)` and physical sheet `(width, height)`.
pub(crate) fn resolve_grid_and_sheet_size(
    layout: NUpLayout,
    page_size: PageSize,
    orientation: Orientation,
    native_w: f64,
    native_h: f64,
) -> Result<(u32, u32, f64, f64)> {
    let (mut cols, mut rows) = match layout {
        NUpLayout::Preset(n) => match n {
            1 => (1, 1),
            2 => (2, 1),
            4 => (2, 2),
            6 => (3, 2),
            8 => (4, 2),
            9 => (3, 3),
            16 => (4, 4),
            other => {
                return Err(PdfrsError::InvalidArgument(format!(
                    "preset layout {other} non supportato (supportati: 1, 2, 4, 6, 8, 9, 16)"
                )));
            }
        },
        NUpLayout::Grid { rows, cols } => {
            if rows == 0 || cols == 0 {
                return Err(PdfrsError::InvalidArgument(
                    "righe e colonne della griglia devono essere maggiori di 0".to_string(),
                ));
            }
            (cols, rows)
        }
    };

    let (base_w, base_h) = match page_size {
        PageSize::A3 => (A3_WIDTH, A3_HEIGHT),
        PageSize::A4 => (A4_WIDTH, A4_HEIGHT),
        PageSize::A5 => (A5_WIDTH, A5_HEIGHT),
        PageSize::Letter => (LETTER_WIDTH, LETTER_HEIGHT),
        PageSize::Legal => (LEGAL_WIDTH, LEGAL_HEIGHT),
        PageSize::Native => (native_w, native_h),
    };

    let (short, long) = (base_w.min(base_h), base_w.max(base_h));

    let (sheet_w, sheet_h) = match orientation {
        Orientation::Portrait => (short, long),
        Orientation::Landscape => (long, short),
        Orientation::Auto => {
            if cols > rows {
                (long, short)
            } else if rows > cols {
                (short, long)
            } else {
                (short, long)
            }
        }
    };

    // For 2-up on a portrait sheet, swap to 1 col x 2 rows
    if sheet_h > sheet_w && cols == 2 && rows == 1 {
        cols = 1;
        rows = 2;
    }

    Ok((cols, rows, sheet_w, sheet_h))
}

/// Computes the PDF transformation matrix mapping the Form XObject's native coordinates
/// into sheet coordinates.
pub(crate) fn compute_subpage_matrix(
    media_x: f64,
    media_y: f64,
    page_w: f64,
    page_h: f64,
    rotation: i64,
    extra_rotation: i64,
    scale: f64,
    offset_x: f64,
    offset_y: f64,
    _draw_w: f64,
    draw_h: f64,
) -> [f64; 6] {
    // 1. Form -> Displayed coordinates
    let form_to_disp = match rotation {
        90 => [0.0, -1.0, 1.0, 0.0, -media_y + page_h, -media_x],
        180 => [-1.0, 0.0, 0.0, -1.0, media_x + page_w, media_y + page_h],
        270 => [0.0, 1.0, -1.0, 0.0, -media_y, media_x + page_w],
        _ => [1.0, 0.0, 0.0, 1.0, -media_x, -media_y],
    };

    // 2. Displayed -> Sheet coordinates
    let disp_to_sheet = match extra_rotation {
        90 => [0.0, -scale, scale, 0.0, offset_x, offset_y + draw_h],
        _ => [scale, 0.0, 0.0, scale, offset_x, offset_y],
    };

    multiply_matrix(form_to_disp, disp_to_sheet)
}

pub(crate) fn multiply_matrix(first: [f64; 6], second: [f64; 6]) -> [f64; 6] {
    let [a1, b1, c1, d1, e1, f1] = first;
    let [a2, b2, c2, d2, e2, f2] = second;
    [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]
}

const INHERIT_LIMIT: usize = 32;

pub(crate) fn get_inherited_attribute(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    for _ in 0..INHERIT_LIMIT {
        let dict = doc.get_dictionary(current).ok()?;
        if let Ok(value) = dict.get(key) {
            return doc.dereference(value).ok().map(|(_, object)| object.clone());
        }
        current = dict.get(b"Parent").and_then(Object::as_reference).ok()?;
    }
    None
}

pub(crate) fn get_page_box(doc: &Document, page_id: ObjectId, page: u32) -> Result<(f64, f64, f64, f64)> {
    let media_box = get_inherited_attribute(doc, page_id, b"MediaBox")
        .ok_or_else(|| PdfrsError::InvalidArgument(format!("la pagina {page} non ha un /MediaBox")))?;

    let values = media_box
        .as_array()
        .map_err(|_| PdfrsError::InvalidArgument(format!("/MediaBox della pagina {page} non è un array")))?;
    if values.len() != 4 {
        return Err(PdfrsError::InvalidArgument(format!(
            "/MediaBox della pagina {page} ha {} valori invece di 4",
            values.len()
        )));
    }

    let mut numbers = [0.0f64; 4];
    for (index, value) in values.iter().enumerate() {
        numbers[index] = doc
            .dereference(value)
            .ok()
            .and_then(|(_, object)| object.as_float().ok())
            .map(|float| float as f64)
            .ok_or_else(|| PdfrsError::InvalidArgument(format!("/MediaBox della pagina {page} non è numerico")))?;
    }

    let [x0, y0, x1, y1] = numbers;
    let (left, right) = (x0.min(x1), x0.max(x1));
    let (bottom, top) = (y0.min(y1), y0.max(y1));
    let (width, height) = (right - left, top - bottom);
    if width <= 0.0 || height <= 0.0 {
        return Err(PdfrsError::InvalidArgument(format!(
            "/MediaBox della pagina {page} è degenere"
        )));
    }

    Ok((left, bottom, width, height))
}

pub(crate) fn get_page_rotation(doc: &Document, page_id: ObjectId) -> i64 {
    let degrees = get_inherited_attribute(doc, page_id, b"Rotate")
        .and_then(|object| object.as_i64().ok())
        .unwrap_or(0);
    let normalized = ((degrees % 360) + 360) % 360;
    if normalized % 90 == 0 { normalized } else { 0 }
}

pub(crate) fn get_page_resources_dict(doc: &Document, page_id: ObjectId) -> Result<Option<Object>> {
    if let Ok(page_dict) = doc.get_dictionary(page_id) {
        if let Ok(res) = page_dict.get(b"Resources") {
            return Ok(doc.dereference(res).ok().map(|(_, obj)| obj.clone()));
        }
    }

    // Try finding inherited resources
    let (_, resource_ids) = doc.get_page_resources(page_id)?;
    if let Some(id) = resource_ids.first() {
        if let Ok(dict) = doc.get_dictionary(*id) {
            return Ok(Some(Object::Dictionary(dict.clone())));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn test_nup_2up_generates_correct_page_count() {
        let doc = multi_page_document(4);
        let options = NUpOptions {
            layout: NUpLayout::Preset(2),
            page_size: PageSize::A4,
            orientation: Orientation::Landscape,
            ..Default::default()
        };

        let result = nup(&doc, options).expect("nup should succeed");
        assert_eq!(result.get_pages().len(), 2);
    }

    #[test]
    fn test_nup_4up_generates_one_page_for_four_input_pages() {
        let doc = multi_page_document(4);
        let options = NUpOptions {
            layout: NUpLayout::Preset(4),
            page_size: PageSize::A4,
            draw_borders: true,
            ..Default::default()
        };

        let result = nup(&doc, options).expect("nup should succeed");
        assert_eq!(result.get_pages().len(), 1);
    }

    #[test]
    fn test_nup_custom_grid() {
        let doc = multi_page_document(6);
        let options = NUpOptions {
            layout: NUpLayout::Grid { rows: 3, cols: 2 },
            page_size: PageSize::A4,
            orientation: Orientation::Portrait,
            direction: FlowDirection::Vertical,
            ..Default::default()
        };

        let result = nup(&doc, options).expect("nup custom grid should succeed");
        assert_eq!(result.get_pages().len(), 1);
    }
}
