use lopdf::Document;

use crate::error::{PdfrsError, Result};

/// A 1-indexed, inclusive page range, e.g. `PageRange { start: 1, end: 3 }` keeps pages 1..=3.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct PageRange {
    pub start: u32,
    pub end: u32,
}

/// Splits `doc` into one document per requested range, keeping only the pages in that range.
pub fn split(doc: &Document, ranges: &[PageRange]) -> Result<Vec<Document>> {
    if ranges.is_empty() {
        return Err(PdfrsError::InvalidArgument("no page ranges provided".to_string()));
    }

    let page_count = doc.get_pages().len() as u32;

    ranges
        .iter()
        .map(|range| {
            if range.start == 0 || range.start > range.end || range.end > page_count {
                return Err(PdfrsError::InvalidArgument(format!(
                    "invalid page range {}..={} for a document with {} page(s)",
                    range.start, range.end, page_count
                )));
            }

            let mut out = doc.clone();
            let pages_to_remove: Vec<u32> = (1..=page_count).filter(|n| *n < range.start || *n > range.end).collect();
            out.delete_pages(&pages_to_remove);
            out.prune_objects();
            out.renumber_objects();
            out.compress();
            Ok(out)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn splits_into_requested_ranges() {
        let doc = multi_page_document(4);

        let parts = split(&doc, &[PageRange { start: 1, end: 2 }, PageRange { start: 3, end: 4 }])
            .expect("split should succeed");

        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].get_pages().len(), 2);
        assert_eq!(parts[1].get_pages().len(), 2);
    }

    #[test]
    fn rejects_out_of_bounds_range() {
        let doc = multi_page_document(2);

        let err = split(&doc, &[PageRange { start: 1, end: 3 }]).unwrap_err();

        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
    }
}
