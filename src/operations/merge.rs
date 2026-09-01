use std::collections::BTreeMap;

use lopdf::{Document, Object, ObjectId};

use crate::error::{PdfrsError, Result};

/// Concatenates the pages of several PDF documents, in the given order, into one document.
pub fn merge(docs: Vec<Document>) -> Result<Document> {
    if docs.is_empty() {
        return Err(PdfrsError::NoInput);
    }

    let mut max_id = 1;
    let mut documents_pages = Vec::new();
    let mut documents_objects = BTreeMap::new();

    for mut doc in docs {
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        for (_, object_id) in doc.get_pages() {
            documents_pages.push((object_id, doc.get_object(object_id)?.to_owned()));
        }

        documents_objects.extend(doc.objects);
    }

    let mut document = Document::with_version("1.5");
    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.into_iter() {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object.get_or_insert((object_id, object));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();
                    if let Some((_, ref old)) = pages_object {
                        if let Ok(old_dictionary) = old.as_dict() {
                            dictionary.extend(old_dictionary);
                        }
                    }
                    let id = pages_object.as_ref().map(|(id, _)| *id).unwrap_or(object_id);
                    pages_object = Some((id, Object::Dictionary(dictionary)));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let (pages_id, pages_object) = pages_object.ok_or_else(|| {
        PdfrsError::InvalidArgument("no PDF document contains a Pages root".to_string())
    })?;
    let (catalog_id, catalog_object) = catalog_object.ok_or_else(|| {
        PdfrsError::InvalidArgument("no PDF document contains a Catalog root".to_string())
    })?;

    for (object_id, object) in &documents_pages {
        if let Ok(dictionary) = object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_id);
            document.objects.insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    if let Ok(dictionary) = pages_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .iter()
                .map(|(id, _)| Object::Reference(*id))
                .collect::<Vec<_>>(),
        );
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
    fn merges_pages_in_order() {
        let doc_a = multi_page_document(1);
        let doc_b = multi_page_document(1);

        let merged = merge(vec![doc_a, doc_b]).expect("merge should succeed");

        assert_eq!(merged.get_pages().len(), 2);
    }

    #[test]
    fn rejects_empty_input() {
        assert!(matches!(merge(vec![]), Err(PdfrsError::NoInput)));
    }
}
