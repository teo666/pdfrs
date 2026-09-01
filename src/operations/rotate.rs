use lopdf::Document;
use serde::Deserialize;

use crate::error::{PdfrsError, Result};

/// Rotates a single page by `degrees` (added to whatever rotation it already has).
/// `degrees` must be a multiple of 90.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PageRotation {
    pub page: u32,
    pub degrees: i64,
}

/// Applies each requested rotation to `doc`'s page dictionaries (the `/Rotate` entry).
pub fn rotate(doc: &mut Document, rotations: &[PageRotation]) -> Result<()> {
    let pages = doc.get_pages();

    for rotation in rotations {
        if rotation.degrees % 90 != 0 {
            return Err(PdfrsError::InvalidArgument(format!(
                "rotation for page {} must be a multiple of 90 degrees, got {}",
                rotation.page, rotation.degrees
            )));
        }

        let page_id = *pages
            .get(&rotation.page)
            .ok_or(PdfrsError::PageNotFound(rotation.page))?;

        let page_dict = doc
            .get_object_mut(page_id)
            .and_then(|obj| obj.as_dict_mut())
            .map_err(|_| PdfrsError::PageNotFound(rotation.page))?;

        let current = page_dict.get(b"Rotate").and_then(|obj| obj.as_i64()).unwrap_or(0);
        let normalized = ((current + rotation.degrees) % 360 + 360) % 360;
        page_dict.set("Rotate", normalized);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn rotates_requested_page() {
        let mut doc = multi_page_document(2);

        rotate(&mut doc, &[PageRotation { page: 1, degrees: 90 }]).expect("rotate should succeed");

        let pages = doc.get_pages();
        let page_id = pages[&1];
        let dict = doc.get_object(page_id).unwrap().as_dict().unwrap();
        assert_eq!(dict.get(b"Rotate").and_then(|o| o.as_i64()).ok(), Some(90));
    }

    #[test]
    fn rejects_non_multiple_of_90() {
        let mut doc = multi_page_document(1);

        let err = rotate(&mut doc, &[PageRotation { page: 1, degrees: 45 }]).unwrap_err();

        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
    }

    #[test]
    fn rejects_missing_page() {
        let mut doc = multi_page_document(1);

        let err = rotate(&mut doc, &[PageRotation { page: 5, degrees: 90 }]).unwrap_err();

        assert!(matches!(err, PdfrsError::PageNotFound(5)));
    }
}
