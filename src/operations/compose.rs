use std::collections::BTreeMap;

use lopdf::{Document, Object, ObjectId};
use serde::Deserialize;

use crate::error::{PdfrsError, Result};

/// References page `page` (1-indexed, as in the source document) of `source`
/// (the index of the source document within the `docs` argument to [`compose`]).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PageRef {
    pub source: u32,
    pub page: u32,
}

/// Builds a new document out of pages picked from several source documents, in
/// any order, allowing pages to be reordered, dropped, or interleaved across
/// documents.
pub fn compose(docs: Vec<Document>, layout: &[PageRef]) -> Result<Document> {
    if docs.is_empty() {
        return Err(PdfrsError::NoInput);
    }
    if layout.is_empty() {
        return Err(PdfrsError::InvalidArgument("no output pages specified".to_string()));
    }

    let mut max_id = 1;
    let mut page_lookup: Vec<BTreeMap<u32, ObjectId>> = Vec::with_capacity(docs.len());
    let mut documents_objects = BTreeMap::new();

    for mut doc in docs {
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        page_lookup.push(doc.get_pages());
        documents_objects.extend(doc.objects);
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;
    let mut document = Document::with_version("1.5");

    for (object_id, object) in documents_objects.iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object.get_or_insert((*object_id, object.clone()));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref old)) = pages_object {
                        if let Ok(old_dictionary) = old.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    let id = pages_object.as_ref().map(|(id, _)| *id).unwrap_or(*object_id);
                    pages_object = Some((id, Object::Dictionary(dictionary)));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(*object_id, object.clone());
            }
        }
    }

    let (pages_id, pages_object) = pages_object.ok_or_else(|| {
        PdfrsError::InvalidArgument("no PDF document contains a Pages root".to_string())
    })?;
    let (catalog_id, catalog_object) = catalog_object.ok_or_else(|| {
        PdfrsError::InvalidArgument("no PDF document contains a Catalog root".to_string())
    })?;

    let mut kids = Vec::with_capacity(layout.len());
    for page_ref in layout {
        let lookup = page_lookup
            .get(page_ref.source as usize)
            .ok_or_else(|| PdfrsError::InvalidArgument(format!("no source document at index {}", page_ref.source)))?;
        let object_id = *lookup.get(&page_ref.page).ok_or(PdfrsError::PageNotFound(page_ref.page))?;
        let object = documents_objects
            .get(&object_id)
            .ok_or(PdfrsError::PageNotFound(page_ref.page))?;

        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_id);
            document.objects.insert(object_id, Object::Dictionary(dictionary));
        }
        kids.push(Object::Reference(object_id));
    }

    if let Ok(dictionary) = pages_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", kids.len() as u32);
        dictionary.set("Kids", kids);
        document.objects.insert(pages_id, Object::Dictionary(dictionary));
    }

    if let Ok(dictionary) = catalog_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", pages_id);
        dictionary.remove(b"Outlines");
        document.objects.insert(catalog_id, Object::Dictionary(dictionary));
    }

    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();
    document.compress();

    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    #[test]
    fn reorders_and_interleaves_pages() {
        let doc_a = multi_page_document(2);
        let doc_b = multi_page_document(1);

        let composed = compose(
            vec![doc_a, doc_b],
            &[
                PageRef { source: 1, page: 1 },
                PageRef { source: 0, page: 2 },
                PageRef { source: 0, page: 1 },
            ],
        )
        .expect("compose should succeed");

        assert_eq!(composed.get_pages().len(), 3);
    }

    #[test]
    fn rejects_missing_page() {
        let doc_a = multi_page_document(1);

        let err = compose(vec![doc_a], &[PageRef { source: 0, page: 9 }]).unwrap_err();

        assert!(matches!(err, PdfrsError::PageNotFound(9)));
    }
}
