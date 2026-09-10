use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object, ObjectId, decode_text_string, text_string};
use serde::{Deserialize, Serialize};

use crate::error::{PdfrsError, Result};

/// The `/Info` keys this operation understands, as (JS-side name, PDF key)
/// pairs. Deliberately a closed set: `/Info` tolerates arbitrary keys, but
/// letting callers write any name they like into the trailer is a footgun,
/// not a feature.
const FIELDS: [(&str, &[u8]); 8] = [
    ("title", b"Title"),
    ("author", b"Author"),
    ("subject", b"Subject"),
    ("keywords", b"Keywords"),
    ("creator", b"Creator"),
    ("producer", b"Producer"),
    ("creationDate", b"CreationDate"),
    ("modDate", b"ModDate"),
];

/// A document's `/Info` metadata. Only the keys actually present in the PDF
/// are `Some` - a missing key and an empty one are different things, and the
/// distinction survives the round-trip to JS (a missing key is simply absent
/// from the object, thanks to `skip_serializing_if`).
///
/// Dates (`creation_date`/`mod_date`) are carried as the raw PDF date string
/// (`D:20240115103000+01'00'`) rather than being parsed: converting them to
/// something JS-native means handling the `+HH'mm'` offset form, which buys
/// nothing here and loses information for the malformed dates real PDFs
/// contain.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DocumentMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keywords: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mod_date: Option<String>,
}

impl DocumentMetadata {
    fn set(&mut self, field: &str, value: String) {
        match field {
            "title" => self.title = Some(value),
            "author" => self.author = Some(value),
            "subject" => self.subject = Some(value),
            "keywords" => self.keywords = Some(value),
            "creator" => self.creator = Some(value),
            "producer" => self.producer = Some(value),
            "creationDate" => self.creation_date = Some(value),
            "modDate" => self.mod_date = Some(value),
            _ => unreachable!("field comes from FIELDS"),
        }
    }
}

/// Reads the document's `/Info` dictionary. A document without one (or with
/// an `/Info` that isn't a dictionary) reads as empty rather than failing:
/// "this PDF has no metadata" is a normal answer, not an error.
///
/// Values are decoded with `lopdf::decode_text_string`, which picks the
/// encoding from the BOM (UTF-16BE or UTF-8) and falls back to PDFDocEncoding
/// - the encodings a PDF text string is allowed to use. A value that fails to
/// decode is skipped rather than sinking the whole read.
pub fn read(doc: &Document) -> DocumentMetadata {
    let mut metadata = DocumentMetadata::default();

    let Some(info) = info_dict(doc) else {
        return metadata;
    };

    for (field, key) in FIELDS {
        if let Ok(object) = info.get(key) {
            // A resolved value can still be a reference in a pathological file.
            let Ok((_, object)) = doc.dereference(object) else { continue };
            if let Ok(text) = decode_text_string(object) {
                metadata.set(field, text);
            }
        }
    }

    metadata
}

/// Applies a patch to the document's `/Info` dictionary, creating it (and
/// hooking it into the trailer) if the document didn't have one.
///
/// The patch is deliberately three-state per field, which a plain struct
/// couldn't express: a key **absent** from the map is left untouched,
/// `Some(text)` sets it, and `None` deletes it. That's what lets a caller
/// clear the author without also wiping the title.
///
/// Values are encoded with `lopdf::text_string`, which stays in
/// PDFDocEncoding for pure-ASCII text and switches to UTF-16BE otherwise, so
/// accented text survives the round-trip.
pub fn write(doc: &mut Document, patch: &HashMap<String, Option<String>>) -> Result<()> {
    // Validate the whole patch before touching the document, so a typo in one
    // field can't leave the others half-applied.
    for field in patch.keys() {
        if !FIELDS.iter().any(|(name, _)| name == field) {
            return Err(PdfrsError::InvalidArgument(format!(
                "unknown metadata field {field:?} (expected one of: {})",
                FIELDS.map(|(name, _)| name).join(", ")
            )));
        }
    }

    for (field, value) in patch {
        if matches!(field.as_str(), "creationDate" | "modDate") {
            if let Some(date) = value {
                validate_date(field, date)?;
            }
        }
    }

    let info = info_dict_mut(doc)?;
    for (field, key) in FIELDS {
        let Some(value) = patch.get(field) else { continue };
        match value {
            Some(text) => info.set(key.to_vec(), text_string(text)),
            None => {
                info.remove(key);
            }
        }
    }

    Ok(())
}

/// PDF dates are `D:YYYYMMDDHHmmSSOHH'mm'`, with everything after the year
/// optional. Only the prefix and the digits are checked here: real-world PDFs
/// carry plenty of dates that are technically malformed, and rejecting them
/// would make the field uneditable rather than fixable.
fn validate_date(field: &str, value: &str) -> Result<()> {
    let rest = value.strip_prefix("D:").ok_or_else(|| {
        PdfrsError::InvalidArgument(format!("{field} must be a PDF date starting with \"D:\", got {value:?}"))
    })?;

    if rest.len() < 4 || !rest[..4].bytes().all(|b| b.is_ascii_digit()) {
        return Err(PdfrsError::InvalidArgument(format!(
            "{field} must start with a 4-digit year after \"D:\", got {value:?}"
        )));
    }

    Ok(())
}

/// `/Info` is normally an indirect reference, but a direct dictionary is
/// legal too - resolve both.
fn info_dict(doc: &Document) -> Option<&Dictionary> {
    let info = doc.trailer.get(b"Info").ok()?;
    doc.dereference(info).ok()?.1.as_dict().ok()
}

/// Same, but creating the dictionary when the document has no `/Info` at all.
fn info_dict_mut(doc: &mut Document) -> Result<&mut Dictionary> {
    match info_object_id(doc) {
        // An indirect /Info: the dictionary lives in the object store.
        Some(id) => doc
            .get_object_mut(id)
            .and_then(|object| object.as_dict_mut())
            .map_err(PdfrsError::from),
        // Either no /Info at all, or a direct one. Both are handled by
        // installing a fresh indirect dictionary (seeded with whatever a
        // direct one held) and pointing the trailer at it - a direct /Info
        // can't be mutated in place through `trailer` without fighting the
        // borrow checker, and normalising it to a reference is what every
        // writer does anyway.
        None => {
            let existing = info_dict(doc).cloned().unwrap_or_default();
            let id = doc.add_object(Object::Dictionary(existing));
            doc.trailer.set("Info", id);
            doc.get_object_mut(id)
                .and_then(|object| object.as_dict_mut())
                .map_err(PdfrsError::from)
        }
    }
}

fn info_object_id(doc: &Document) -> Option<ObjectId> {
    doc.trailer.get(b"Info").ok()?.as_reference().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;

    fn patch(entries: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.map(str::to_string)))
            .collect()
    }

    #[test]
    fn reads_empty_metadata_from_a_document_without_info() {
        // multi_page_document builds a trailer with only /Root - no /Info.
        let doc = multi_page_document(1);
        assert_eq!(read(&doc), DocumentMetadata::default());
    }

    #[test]
    fn write_creates_the_info_dictionary_and_hooks_it_into_the_trailer() {
        let mut doc = multi_page_document(1);
        assert!(doc.trailer.get(b"Info").is_err());

        write(&mut doc, &patch(&[("title", Some("Relazione"))])).expect("write should succeed");

        assert!(doc.trailer.get(b"Info").unwrap().as_reference().is_ok());
        assert_eq!(read(&doc).title.as_deref(), Some("Relazione"));
    }

    #[test]
    fn round_trips_non_ascii_text_through_utf16() {
        let mut doc = multi_page_document(1);
        write(
            &mut doc,
            &patch(&[("author", Some("Sofía Ünal — 日本語")), ("title", Some("plain ascii"))]),
        )
        .unwrap();

        // Survives a real save/load cycle, not just the in-memory dictionary.
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let reloaded = Document::load_mem(&bytes).unwrap();

        let metadata = read(&reloaded);
        assert_eq!(metadata.author.as_deref(), Some("Sofía Ünal — 日本語"));
        assert_eq!(metadata.title.as_deref(), Some("plain ascii"));
    }

    #[test]
    fn absent_key_is_left_alone_and_none_deletes_it() {
        let mut doc = multi_page_document(1);
        write(&mut doc, &patch(&[("title", Some("Titolo")), ("author", Some("Autore"))])).unwrap();

        // Patch touching only the author: the title must survive untouched...
        write(&mut doc, &patch(&[("author", None)])).unwrap();

        let metadata = read(&doc);
        assert_eq!(metadata.title.as_deref(), Some("Titolo"));
        assert_eq!(metadata.author, None, "None should remove the key entirely");
    }

    #[test]
    fn empty_string_is_a_value_not_a_deletion() {
        let mut doc = multi_page_document(1);
        write(&mut doc, &patch(&[("subject", Some(""))])).unwrap();
        assert_eq!(read(&doc).subject.as_deref(), Some(""));
    }

    #[test]
    fn rejects_an_unknown_field_without_applying_the_rest() {
        let mut doc = multi_page_document(1);
        let err = write(&mut doc, &patch(&[("title", Some("Titolo")), ("bogus", Some("x"))])).unwrap_err();

        assert!(matches!(err, PdfrsError::InvalidArgument(_)));
        assert_eq!(read(&doc).title, None, "a rejected patch must not half-apply");
    }

    #[test]
    fn rejects_a_malformed_date() {
        let mut doc = multi_page_document(1);
        assert!(matches!(
            write(&mut doc, &patch(&[("creationDate", Some("15 gennaio 2024"))])).unwrap_err(),
            PdfrsError::InvalidArgument(_)
        ));
        // A well-formed one goes through untouched, offset and all.
        write(&mut doc, &patch(&[("creationDate", Some("D:20240115103000+01'00'"))])).unwrap();
        assert_eq!(read(&doc).creation_date.as_deref(), Some("D:20240115103000+01'00'"));
    }

    #[test]
    fn overwrites_an_existing_value() {
        let mut doc = multi_page_document(1);
        write(&mut doc, &patch(&[("producer", Some("primo"))])).unwrap();
        write(&mut doc, &patch(&[("producer", Some("secondo"))])).unwrap();
        assert_eq!(read(&doc).producer.as_deref(), Some("secondo"));
    }
}
