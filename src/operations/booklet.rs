use lopdf::content::Operation;
use lopdf::{dictionary, Document, Object, Stream};
use serde::Deserialize;

use crate::error::{PdfrsError, Result};
use crate::operations::nup::{
    create_page_form_xobject, render_subpage_in_cell, resolve_grid_and_sheet_size, NUpLayout,
    Orientation, PageSize, SourcePageInfo,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BindingEdge {
    /// Standard Western left-to-right binding.
    Left,
    /// Right-to-left binding (e.g. Manga, Arabic, Hebrew).
    Right,
}

impl Default for BindingEdge {
    fn default() -> Self {
        BindingEdge::Left
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuplexMode {
    /// Sequential front and back faces (Sheet 1 Front, Sheet 1 Back, Sheet 2 Front, Sheet 2 Back...).
    BothSides,
    /// Only front faces (useful for manual two-pass duplex printing).
    FrontOnly,
    /// Only back faces.
    BackOnly,
}

impl Default for DuplexMode {
    fn default() -> Self {
        DuplexMode::BothSides
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookletOptions {
    pub page_size: PageSize,
    pub orientation: Orientation,
    pub binding: BindingEdge,
    pub duplex: DuplexMode,
    /// Outer margin of the sheet in PDF points (default: 15.0 pt).
    pub margin: f64,
    /// Gutter space along the central fold in PDF points (default: 10.0 pt).
    pub gutter: f64,
    /// Whether to draw a thin border around each subpage.
    pub draw_borders: bool,
    /// Whether to draw a subtle dashed line along the center fold.
    pub draw_fold_line: bool,
    /// Whether to auto-rotate subpages to maximize fit.
    pub auto_rotate: bool,
}

impl Default for BookletOptions {
    fn default() -> Self {
        Self {
            page_size: PageSize::A4,
            orientation: Orientation::Landscape,
            binding: BindingEdge::Left,
            duplex: DuplexMode::BothSides,
            margin: 15.0,
            gutter: 10.0,
            draw_borders: false,
            draw_fold_line: false,
            auto_rotate: true,
        }
    }
}

/// Transforms the source document into a saddle-stitched folded booklet (fascicolo rilegato).
pub fn booklet(doc: &Document, options: BookletOptions) -> Result<Document> {
    let source_pages = doc.get_pages();
    if source_pages.is_empty() {
        return Err(PdfrsError::InvalidArgument("il documento non contiene pagine".to_string()));
    }

    let page_count = source_pages.len();
    // Booklet pages must be a multiple of 4
    let padded_count = ((page_count + 3) / 4) * 4;
    let sheet_count = padded_count / 4;

    let mut out_doc = doc.clone();

    // 1. Convert all existing pages to Form XObjects
    let mut pages_info = Vec::with_capacity(page_count);
    for (page_num, page_id) in source_pages.iter() {
        let info = create_page_form_xobject(&mut out_doc, *page_id, *page_num)?;
        pages_info.push(info);
    }

    // 2. Resolve sheet dimensions (default is Landscape for vertical fold booklet)
    let first_page = &pages_info[0];
    let (_, _, sheet_width, sheet_height) = resolve_grid_and_sheet_size(
        NUpLayout::Preset(2),
        options.page_size,
        options.orientation,
        first_page.width,
        first_page.height,
    )?;

    let margin = options.margin.max(0.0);
    let gutter = options.gutter.max(0.0);

    let usable_w = (sheet_width - 2.0 * margin - gutter).max(1.0);
    let cell_w = usable_w / 2.0;
    let cell_h = (sheet_height - 2.0 * margin).max(1.0);

    let left_cell_x = margin;
    let right_cell_x = margin + cell_w + gutter;
    let cell_y = margin;

    // 3. Compute booklet faces
    // Each physical sheet k has a Front face and a Back face
    struct BookletFace {
        left_page: usize, // 1-indexed (padded > page_count means blank)
        right_page: usize,
    }

    let mut faces: Vec<BookletFace> = Vec::with_capacity(sheet_count * 2);

    for k in 0..sheet_count {
        // Front face: [ N - 2k, 2k + 1 ]
        let front_left = padded_count - 2 * k;
        let front_right = 2 * k + 1;

        // Back face: [ 2k + 2, N - 2k - 1 ]
        let back_left = 2 * k + 2;
        let back_right = padded_count - 2 * k - 1;

        let (fl, fr) = if options.binding == BindingEdge::Right {
            (front_right, front_left)
        } else {
            (front_left, front_right)
        };

        let (bl, br) = if options.binding == BindingEdge::Right {
            (back_right, back_left)
        } else {
            (back_left, back_right)
        };

        match options.duplex {
            DuplexMode::BothSides => {
                faces.push(BookletFace {
                    left_page: fl,
                    right_page: fr,
                });
                faces.push(BookletFace {
                    left_page: bl,
                    right_page: br,
                });
            }
            DuplexMode::FrontOnly => {
                faces.push(BookletFace {
                    left_page: fl,
                    right_page: fr,
                });
            }
            DuplexMode::BackOnly => {
                faces.push(BookletFace {
                    left_page: bl,
                    right_page: br,
                });
            }
        }
    }

    // 4. Generate output pages
    let pages_id = out_doc.new_object_id();
    let mut new_page_ids = Vec::with_capacity(faces.len());

    for face in &faces {
        let mut content_ops: Vec<Operation> = Vec::new();
        let mut xobjects = lopdf::Dictionary::new();

        let render_page = |ops: &mut Vec<Operation>,
                           xobjs: &mut lopdf::Dictionary,
                           page_1idx: usize,
                           cell_x: f64| {
            if page_1idx <= page_count {
                let page_info: &SourcePageInfo = &pages_info[page_1idx - 1];
                let res_name = format!("BkFm{}", page_1idx);
                xobjs.set(res_name.clone(), Object::Reference(page_info.form_id));

                render_subpage_in_cell(
                    ops,
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
        };

        render_page(&mut content_ops, &mut xobjects, face.left_page, left_cell_x);
        render_page(&mut content_ops, &mut xobjects, face.right_page, right_cell_x);

        // Draw central fold line if enabled
        if options.draw_fold_line {
            let center_x = sheet_width / 2.0;
            content_ops.push(Operation::new("q", vec![]));
            content_ops.push(Operation::new("0.5", vec![]));
            content_ops.push(Operation::new("w", vec![Object::Real(0.5)]));
            content_ops.push(Operation::new(
                "d",
                vec![
                    Object::Array(vec![Object::Real(3.0), Object::Real(3.0)]),
                    Object::Real(0.0),
                ],
            ));
            content_ops.push(Operation::new(
                "RG",
                vec![Object::Real(0.7), Object::Real(0.7), Object::Real(0.7)],
            ));
            content_ops.push(Operation::new(
                "m",
                vec![Object::Real(center_x as f32), Object::Real(margin as f32)],
            ));
            content_ops.push(Operation::new(
                "l",
                vec![
                    Object::Real(center_x as f32),
                    Object::Real((sheet_height - margin) as f32),
                ],
            ));
            content_ops.push(Operation::new("S", vec![]));
            content_ops.push(Operation::new("Q", vec![]));
        }

        let content_bytes = lopdf::content::Content {
            operations: content_ops,
        }
        .encode()
        .map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?;

        let mut content_stream = Stream::new(dictionary! {}, content_bytes);
        content_stream.compress().map_err(PdfrsError::from)?;
        let content_id = out_doc.add_object(content_stream);

        let resources_id = out_doc.add_object(dictionary! {
            "XObject" => xobjects,
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

    // Replace Catalog and Pages root
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

    // Delete old unreferenced Page objects
    for (_, old_page_id) in source_pages {
        out_doc.objects.remove(&old_page_id);
    }

    out_doc.renumber_objects();
    out_doc.compress();

    Ok(out_doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn test_booklet_4_pages_creates_two_sheets() {
        let doc = multi_page_document(4);
        let options = BookletOptions::default();

        let result = booklet(&doc, options).expect("booklet should succeed");
        // 4 pages booklet -> 1 sheet -> 2 faces (front, back)
        assert_eq!(result.get_pages().len(), 2);
    }

    #[test]
    fn test_booklet_6_pages_pads_to_8_pages_and_creates_four_faces() {
        let doc = multi_page_document(6);
        let options = BookletOptions::default();

        let result = booklet(&doc, options).expect("booklet should succeed");
        // 6 pages padded to 8 -> 2 sheets -> 4 faces
        assert_eq!(result.get_pages().len(), 4);
    }

    #[test]
    fn test_booklet_front_only_duplex() {
        let doc = multi_page_document(8);
        let options = BookletOptions {
            duplex: DuplexMode::FrontOnly,
            ..Default::default()
        };

        let result = booklet(&doc, options).expect("booklet front only should succeed");
        // 8 pages = 2 sheets -> 2 front faces
        assert_eq!(result.get_pages().len(), 2);
    }
}
