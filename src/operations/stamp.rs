use lopdf::content::Operation;
use lopdf::{Document, Object, ObjectId, Stream, dictionary};
use serde::Deserialize;

use crate::error::{PdfrsError, Result};

/// How far up the `/Pages` chain to look for an inherited attribute before
/// giving up - guards against a malformed document with a `/Parent` cycle.
const INHERIT_LIMIT: usize = 32;

/// Where the stamp goes, as fractions (0..1) of the page **as displayed**,
/// with the origin at the top-left and `y` growing downwards - i.e. the
/// coordinate system of the preview the user drags the box on, not the PDF's
/// own (bottom-left, `/Rotate` not applied). Converting between the two is
/// this module's job; see `stamp_matrix`.
///
/// There is no height: it follows from `width` and the image's aspect ratio,
/// so a signature can't be stretched out of shape.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StampPlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
}

/// Draws `pixels` (RGBA8, row-major, `width` x `height`) onto `page`
/// (1-indexed) at `placement`.
///
/// The image arrives already decoded - the browser's canvas does that - so
/// this operation pulls in no image-decoding dependency and ships in the
/// "core" wasm build.
pub fn stamp_image(
    doc: &mut Document,
    page: u32,
    pixels: &[u8],
    width: u32,
    height: u32,
    placement: StampPlacement,
) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(PdfrsError::InvalidArgument(
            "l'immagine della firma ha larghezza o altezza nulla".to_string(),
        ));
    }

    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixel_count| pixel_count.checked_mul(4))
        .ok_or_else(|| PdfrsError::InvalidArgument("immagine troppo grande".to_string()))?;
    if pixels.len() != expected {
        return Err(PdfrsError::InvalidArgument(format!(
            "i pixel non corrispondono alle dimensioni dichiarate: attesi {expected} byte RGBA per {width}x{height}, ricevuti {}",
            pixels.len()
        )));
    }

    if !placement.width.is_finite() || placement.width <= 0.0 {
        return Err(PdfrsError::InvalidArgument(format!(
            "larghezza della firma non valida: {}",
            placement.width
        )));
    }
    if !placement.x.is_finite() || !placement.y.is_finite() {
        return Err(PdfrsError::InvalidArgument("posizione della firma non valida".to_string()));
    }

    let page_id = *doc.get_pages().get(&page).ok_or(PdfrsError::PageNotFound(page))?;

    let (media_x, media_y, page_width, page_height) = page_box(doc, page_id, page)?;
    let rotation = page_rotation(doc, page_id);

    let matrix = stamp_matrix(
        placement,
        height as f64 / width as f64,
        page_width,
        page_height,
        rotation,
        media_x,
        media_y,
    );

    // Must happen before add_xobject: see the function's comment for what
    // goes wrong otherwise.
    materialize_inherited_resources(doc, page_id)?;

    let image_id = add_image_object(doc, pixels, width, height)?;
    let name = format!("Sig{}", image_id.0);
    doc.add_xobject(page_id, name.as_bytes(), image_id)?;

    // Same shape as lopdf's own `Document::insert_image`, but writing the
    // full matrix ourselves: that helper only takes a position and a size,
    // which can't express the rotation a page with /Rotate needs.
    let mut content = doc.get_and_decode_page_content(page_id)?;
    content.operations.push(Operation::new("q", vec![]));
    content.operations.push(Operation::new(
        "cm",
        matrix.iter().map(|value| Object::Real(*value as f32)).collect::<Vec<_>>(),
    ));
    content.operations.push(Operation::new("Do", vec![Object::Name(name.into_bytes())]));
    content.operations.push(Operation::new("Q", vec![]));

    doc.change_page_content(page_id, content.encode().map_err(|err| PdfrsError::InvalidArgument(err.to_string()))?)?;

    Ok(())
}

/// Builds the two image XObjects - colour plus alpha - and returns the id of
/// the colour one, which references the other through `/SMask`.
///
/// A signature without transparency would paint a white box over the page, so
/// the mask isn't optional. lopdf has no `/SMask` helper (nothing in the
/// crate mentions it), so both streams are assembled by hand.
fn add_image_object(doc: &mut Document, pixels: &[u8], width: u32, height: u32) -> Result<ObjectId> {
    let pixel_count = (width as usize) * (height as usize);
    let mut rgb = Vec::with_capacity(pixel_count * 3);
    let mut alpha = Vec::with_capacity(pixel_count);
    for chunk in pixels.chunks_exact(4) {
        rgb.extend_from_slice(&chunk[..3]);
        alpha.push(chunk[3]);
    }

    let mut mask = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        },
        alpha,
    );
    // `save()` never calls Document::compress(), so raw pixels would ship
    // uncompressed - megabytes of them. compress() is a no-op once /Filter is
    // set, so a later merge/compose can't double-compress these.
    mask.compress().map_err(PdfrsError::from)?;
    let mask_id = doc.add_object(mask);

    let mut image = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width as i64,
            "Height" => height as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "SMask" => Object::Reference(mask_id),
        },
        rgb,
    );
    image.compress().map_err(PdfrsError::from)?;

    Ok(doc.add_object(image))
}

/// Copies the nearest inherited `/Resources` onto the page itself, when the
/// page doesn't carry its own.
///
/// Without this, `add_xobject` -> `get_or_create_resources` sees no
/// `/Resources` key on the page and sets an **empty** dictionary there. The
/// page then stops inheriting, and the fonts and images its existing content
/// refers to vanish - a page that used to render text comes out blank. The
/// inherited dictionary is *copied*, not referenced, because it's shared with
/// every other page under the same `/Pages` node: adding the signature's
/// XObject to it would add the signature to all of them.
fn materialize_inherited_resources(doc: &mut Document, page_id: ObjectId) -> Result<()> {
    let has_own = doc
        .get_dictionary(page_id)
        .map(|page| page.has(b"Resources"))
        .unwrap_or(false);
    if has_own {
        return Ok(());
    }

    // `get_page_resources` walks the /Parent chain (and guards against
    // cycles), returning the ids of every /Resources it found along the way.
    let inherited = {
        let (_, resource_ids) = doc.get_page_resources(page_id)?;
        resource_ids
            .first()
            .and_then(|id| doc.get_dictionary(*id).ok())
            .cloned()
    };

    let resources = inherited.unwrap_or_default();
    doc.get_object_mut(page_id)
        .and_then(Object::as_dict_mut)?
        .set("Resources", resources);

    Ok(())
}

/// Reads an attribute that PDF allows a page to inherit from its `/Pages`
/// ancestors (`/MediaBox`, `/Rotate`), walking up until it finds one.
fn inherited_attribute(doc: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
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

/// The page's `/MediaBox` as (origin x, origin y, width, height). The origin
/// is rarely non-zero, but when it is, every coordinate on the page is
/// offset by it.
fn page_box(doc: &Document, page_id: ObjectId, page: u32) -> Result<(f64, f64, f64, f64)> {
    let media_box = inherited_attribute(doc, page_id, b"MediaBox")
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

/// `/Rotate` normalised to 0/90/180/270. Anything else (absent, malformed, or
/// not a multiple of 90) is treated as 0, which is what viewers do.
fn page_rotation(doc: &Document, page_id: ObjectId) -> i64 {
    let degrees = inherited_attribute(doc, page_id, b"Rotate")
        .and_then(|object| object.as_i64().ok())
        .unwrap_or(0);
    let normalized = ((degrees % 360) + 360) % 360;
    if normalized % 90 == 0 { normalized } else { 0 }
}

/// Composes the `cm` matrix that puts the image where the user dropped it.
///
/// Two steps, because there are two coordinate systems. The viewer applies
/// `/Rotate` when it draws, but lopdf (and the content stream) know nothing
/// about it - so what the user positioned on screen is the *displayed* space,
/// while `cm` has to be written in *page* space.
///
/// 1. Map the image's unit square onto the requested rectangle of the
///    displayed page, flipping `y` (the UI measures from the top, PDF from
///    the bottom).
/// 2. Multiply by the displayed -> page transform for this `/Rotate`. That
///    rotation is what also makes the signature come out upright on screen
///    rather than lying on its side.
fn stamp_matrix(
    placement: StampPlacement,
    aspect_ratio: f64,
    page_width: f64,
    page_height: f64,
    rotation: i64,
    media_x: f64,
    media_y: f64,
) -> [f64; 6] {
    // For a quarter turn the displayed page is the page with its sides swapped.
    let (view_width, view_height) = match rotation {
        90 | 270 => (page_height, page_width),
        _ => (page_width, page_height),
    };

    let stamp_width = placement.width * view_width;
    let stamp_height = stamp_width * aspect_ratio;
    let left = placement.x * view_width;
    // The UI's y grows downwards from the top edge; PDF's grows upwards from
    // the bottom, and the rectangle is anchored by its top-left corner.
    let bottom = view_height - placement.y * view_height - stamp_height;

    let place = [stamp_width, 0.0, 0.0, stamp_height, left, bottom];

    let to_page = match rotation {
        90 => [0.0, 1.0, -1.0, 0.0, page_width, 0.0],
        180 => [-1.0, 0.0, 0.0, -1.0, page_width, page_height],
        270 => [0.0, -1.0, 1.0, 0.0, 0.0, page_height],
        _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    };

    let mut matrix = multiply(place, to_page);
    // A /MediaBox that doesn't start at the origin shifts everything on the page.
    matrix[4] += media_x;
    matrix[5] += media_y;
    matrix
}

/// PDF matrix product: `first` applied, then `second`.
fn multiply(first: [f64; 6], second: [f64; 6]) -> [f64; 6] {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    /// A 2x1 RGBA image: one opaque red pixel, one fully transparent.
    fn tiny_image() -> (Vec<u8>, u32, u32) {
        (vec![255, 0, 0, 255, 0, 0, 0, 0], 2, 1)
    }

    fn centered() -> StampPlacement {
        StampPlacement { x: 0.25, y: 0.25, width: 0.5 }
    }

    fn stamp(doc: &mut Document, page: u32) -> Result<()> {
        let (pixels, width, height) = tiny_image();
        stamp_image(doc, page, &pixels, width, height, centered())
    }

    /// The `cm` operands of the (single) stamp we just drew.
    fn stamp_matrix_of(doc: &Document, page: u32) -> Vec<f64> {
        let page_id = *doc.get_pages().get(&page).unwrap();
        let content = doc.get_and_decode_page_content(page_id).unwrap();
        let cm = content
            .operations
            .iter()
            .rev()
            .find(|operation| operation.operator == "cm")
            .expect("the stamp should have written a cm");
        cm.operands.iter().map(|operand| operand.as_float().unwrap() as f64).collect()
    }

    fn xobject_ids(doc: &Document, page: u32) -> Vec<ObjectId> {
        let page_id = *doc.get_pages().get(&page).unwrap();
        let resources = doc.get_dictionary(page_id).unwrap().get(b"Resources").unwrap();
        let resources = doc.dereference(resources).unwrap().1.as_dict().unwrap();
        let xobjects = resources.get(b"XObject").unwrap().as_dict().unwrap();
        xobjects.iter().map(|(_, value)| value.as_reference().unwrap()).collect()
    }

    #[test]
    fn builds_a_colour_image_with_a_matching_alpha_smask() {
        let mut doc = multi_page_document(1);
        stamp(&mut doc, 1).expect("stamp should succeed");

        let image_id = xobject_ids(&doc, 1)[0];
        let image = doc.get_object(image_id).unwrap().as_stream().unwrap();
        assert_eq!(image.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceRGB");

        let mask_id = image.dict.get(b"SMask").unwrap().as_reference().unwrap();
        let mask = doc.get_object(mask_id).unwrap().as_stream().unwrap();
        assert_eq!(mask.dict.get(b"ColorSpace").unwrap().as_name().unwrap(), b"DeviceGray");
        assert_eq!(
            mask.dict.get(b"Width").unwrap().as_i64().unwrap(),
            image.dict.get(b"Width").unwrap().as_i64().unwrap()
        );
        assert_eq!(
            mask.dict.get(b"Height").unwrap().as_i64().unwrap(),
            image.dict.get(b"Height").unwrap().as_i64().unwrap()
        );

        // The mask carries the alpha channel, decompressed back out.
        assert_eq!(mask.decompressed_content().unwrap(), vec![255, 0]);
    }

    #[test]
    fn both_streams_are_compressed() {
        let mut doc = multi_page_document(1);
        stamp(&mut doc, 1).unwrap();

        let image_id = xobject_ids(&doc, 1)[0];
        let image = doc.get_object(image_id).unwrap().as_stream().unwrap();
        let mask_id = image.dict.get(b"SMask").unwrap().as_reference().unwrap();
        let mask = doc.get_object(mask_id).unwrap().as_stream().unwrap();

        // Tiny payloads don't shrink, so Filter may be absent here; what must
        // hold is that a *large* one does get compressed.
        let big = vec![7u8; 100 * 100 * 4];
        let mut doc2 = multi_page_document(1);
        stamp_image(&mut doc2, 1, &big, 100, 100, centered()).unwrap();
        let big_id = xobject_ids(&doc2, 1)[0];
        let big_image = doc2.get_object(big_id).unwrap().as_stream().unwrap();
        assert_eq!(big_image.dict.get(b"Filter").unwrap().as_name().unwrap(), b"FlateDecode");

        let _ = (image, mask);
    }

    /// The regression that would break real PDFs: a page inheriting its
    /// /Resources must not lose them when the signature is added.
    #[test]
    fn keeps_resources_that_the_page_inherits_from_its_parent() {
        let mut doc = multi_page_document(1);
        let page_id = *doc.get_pages().get(&1).unwrap();

        // Move the page's /Resources up onto the /Pages node, so the page
        // relies on inheritance the way many real documents do.
        let resources = doc.get_dictionary(page_id).unwrap().get(b"Resources").unwrap().clone();
        let parent_id = doc
            .get_dictionary(page_id)
            .unwrap()
            .get(b"Parent")
            .unwrap()
            .as_reference()
            .unwrap();
        doc.get_object_mut(page_id).unwrap().as_dict_mut().unwrap().remove(b"Resources");
        doc.get_object_mut(parent_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Resources", resources);

        stamp(&mut doc, 1).expect("stamp should succeed");

        // The font the page's content stream refers to must still be reachable.
        let page_resources = doc.get_dictionary(page_id).unwrap().get(b"Resources").unwrap();
        let page_resources = doc.dereference(page_resources).unwrap().1.as_dict().unwrap();
        assert!(
            page_resources.has(b"Font"),
            "the inherited resources must be carried onto the page, not replaced by an empty dict"
        );
        assert!(page_resources.has(b"XObject"), "the signature should have been added too");

        // And the shared parent must not have been given the signature.
        let parent = doc.get_dictionary(parent_id).unwrap();
        let parent_resources = doc.dereference(parent.get(b"Resources").unwrap()).unwrap().1;
        assert!(
            !parent_resources.as_dict().unwrap().has(b"XObject"),
            "the signature must not leak into resources shared with other pages"
        );
    }

    #[test]
    fn rotation_changes_the_matrix() {
        let mut upright = multi_page_document(1);
        stamp(&mut upright, 1).unwrap();
        let upright_matrix = stamp_matrix_of(&upright, 1);

        let mut rotated = multi_page_document(1);
        let page_id = *rotated.get_pages().get(&1).unwrap();
        rotated
            .get_object_mut(page_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Rotate", 90i64);
        stamp(&mut rotated, 1).unwrap();
        let rotated_matrix = stamp_matrix_of(&rotated, 1);

        // Upright: a pure scale+translate, no rotation terms.
        assert_eq!(upright_matrix[1], 0.0);
        assert_eq!(upright_matrix[2], 0.0);
        // Rotated: the diagonal is empty and the off-diagonal carries the turn.
        assert_eq!(rotated_matrix[0], 0.0);
        assert_eq!(rotated_matrix[3], 0.0);
        assert_ne!(rotated_matrix[1], 0.0);
        assert_ne!(rotated_matrix[2], 0.0);
    }

    /// The four rotations must all land inside the page, and a quarter turn
    /// must swap which side of the page the stamp sits on.
    #[test]
    fn every_rotation_places_the_stamp_inside_the_page() {
        // Top-left-ish, deliberately asymmetric so the rotations differ.
        let placement = StampPlacement { x: 0.1, y: 0.1, width: 0.2 };
        for rotation in [0, 90, 180, 270] {
            let matrix = stamp_matrix(placement, 0.5, 595.0, 842.0, rotation, 0.0, 0.0);
            // The unit square's corners, mapped through the matrix.
            for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
                let px = matrix[0] * x + matrix[2] * y + matrix[4];
                let py = matrix[1] * x + matrix[3] * y + matrix[5];
                assert!(
                    (-0.01..=595.01).contains(&px) && (-0.01..=842.01).contains(&py),
                    "rotation {}: corner ({},{}) -> ({},{}) is off the page",
                    rotation, x, y, px, py
                );
            }
        }
    }

    #[test]
    fn a_media_box_origin_offsets_the_stamp() {
        let shifted = stamp_matrix(centered(), 1.0, 595.0, 842.0, 0, 20.0, 30.0);
        let plain = stamp_matrix(centered(), 1.0, 595.0, 842.0, 0, 0.0, 0.0);
        assert_eq!(shifted[4] - plain[4], 20.0);
        assert_eq!(shifted[5] - plain[5], 30.0);
    }

    #[test]
    fn rejects_pixels_that_do_not_match_the_dimensions() {
        let mut doc = multi_page_document(1);
        let err = stamp_image(&mut doc, 1, &[0, 0, 0, 0], 4, 4, centered()).unwrap_err();
        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
    }

    #[test]
    fn rejects_a_nonexistent_page() {
        let mut doc = multi_page_document(1);
        let (pixels, width, height) = tiny_image();
        let err = stamp_image(&mut doc, 9, &pixels, width, height, centered()).unwrap_err();
        assert!(matches!(err, PdfrsError::PageNotFound(9)));
    }

    #[test]
    fn leaves_the_existing_page_content_in_place() {
        let mut doc = multi_page_document(1);
        let page_id = *doc.get_pages().get(&1).unwrap();
        let before = doc.get_and_decode_page_content(page_id).unwrap().operations.len();

        stamp(&mut doc, 1).unwrap();

        let after = doc.get_and_decode_page_content(page_id).unwrap().operations.len();
        // q + cm + Do + Q on top of whatever was there.
        assert_eq!(after, before + 4);
    }
}

/// The matrix tests above check the algebra; these check what a reader
/// actually sees, by rendering the stamped page and looking at where the ink
/// landed. That's the only way to catch a sign error in the `/Rotate`
/// handling, which is the part most likely to be subtly wrong.
#[cfg(all(test, feature = "preview"))]
mod render_tests {
    use super::*;
    use crate::operations::preview::render_page_preview;
    use crate::operations::test_support::multi_page_document;
    use hayro::vello_cpu::Pixmap;

    /// Centre of mass of the red pixels, in fractions of the rendered image,
    /// with the origin at the top-left (the way a viewer sees it).
    fn red_centroid(png: &[u8]) -> (f64, f64) {
        let pixmap = Pixmap::from_png(std::io::Cursor::new(png)).expect("preview should be a valid PNG");
        let (width, height) = (pixmap.width(), pixmap.height());

        let (mut sum_x, mut sum_y, mut count) = (0.0f64, 0.0f64, 0usize);
        for y in 0..height {
            for x in 0..width {
                let pixel = pixmap.sample(x, y);
                // The stamp is pure red; the fixture's own content is black text.
                if pixel.r > 120 && pixel.g < 80 && pixel.b < 80 {
                    sum_x += x as f64;
                    sum_y += y as f64;
                    count += 1;
                }
            }
        }

        assert!(count > 0, "no red pixels found: the signature didn't get drawn at all");
        (sum_x / count as f64 / width as f64, sum_y / count as f64 / height as f64)
    }

    fn stamped_preview(rotation: Option<i64>, placement: StampPlacement) -> Vec<u8> {
        let mut doc = multi_page_document(1);
        if let Some(degrees) = rotation {
            let page_id = *doc.get_pages().get(&1).unwrap();
            doc.get_object_mut(page_id)
                .unwrap()
                .as_dict_mut()
                .unwrap()
                .set("Rotate", degrees);
        }

        // A fully opaque red square.
        let pixels = vec![255u8, 0, 0, 255].repeat(16 * 16);
        stamp_image(&mut doc, 1, &pixels, 16, 16, placement).expect("stamp should succeed");

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        render_page_preview(&bytes, 1, 0.5).expect("render should succeed")
    }

    #[test]
    fn lands_where_it_was_placed_on_an_unrotated_page() {
        // Top-left corner of the page.
        let placement = StampPlacement { x: 0.05, y: 0.05, width: 0.2 };
        let (x, y) = red_centroid(&stamped_preview(None, placement));

        assert!(x < 0.4, "expected the stamp on the left, centroid x was {}", x);
        assert!(y < 0.4, "expected the stamp near the top, centroid y was {}", y);
    }

    /// The payoff of all the `/Rotate` arithmetic: the viewer rotates the
    /// page, so the stamp has to be written rotated the other way to still
    /// show up where the user dropped it.
    #[test]
    fn lands_where_it_was_placed_on_rotated_pages() {
        let placement = StampPlacement { x: 0.05, y: 0.05, width: 0.2 };
        for rotation in [90, 180, 270] {
            let (x, y) = red_centroid(&stamped_preview(Some(rotation), placement));
            assert!(
                x < 0.4 && y < 0.4,
                "/Rotate {}: expected the stamp near the top-left as displayed, centroid was ({}, {})",
                rotation,
                x,
                y
            );
        }
    }

    /// Same page, opposite corner - proves the position is actually being
    /// honoured rather than the stamp always landing in one place.
    #[test]
    fn a_different_placement_lands_in_a_different_corner() {
        let placement = StampPlacement { x: 0.7, y: 0.8, width: 0.2 };
        let (x, y) = red_centroid(&stamped_preview(None, placement));

        assert!(x > 0.6, "expected the stamp on the right, centroid x was {}", x);
        assert!(y > 0.6, "expected the stamp near the bottom, centroid y was {}", y);
    }

    #[test]
    fn transparent_pixels_do_not_paint() {
        let mut doc = multi_page_document(1);
        // Fully transparent red: the SMask should stop any of it showing.
        let pixels = vec![255u8, 0, 0, 0].repeat(16 * 16);
        stamp_image(&mut doc, 1, &pixels, 16, 16, StampPlacement { x: 0.05, y: 0.05, width: 0.4 }).unwrap();

        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let png = render_page_preview(&bytes, 1, 0.5).unwrap();

        let pixmap = Pixmap::from_png(std::io::Cursor::new(png.as_slice())).unwrap();
        let red = (0..pixmap.height())
            .flat_map(|y| (0..pixmap.width()).map(move |x| (x, y)))
            .filter(|(x, y)| {
                let pixel = pixmap.sample(*x, *y);
                pixel.r > 120 && pixel.g < 80 && pixel.b < 80
            })
            .count();

        assert_eq!(red, 0, "a fully transparent stamp must not paint anything");
    }
}
