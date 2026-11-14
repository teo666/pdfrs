//! A PDF's outline - the bookmarks readers show beside the pages - read
//! and written as a flat list of entries, each with its level.
//!
//! lopdf's own `get_toc` drops what this keeps: entries whose destination
//! it can't resolve (they're kept here, without a page), whether a branch
//! starts open or closed, and where on the page an entry points. It also
//! gives up on the first malformed entry; this reads what it can.

use std::collections::{BTreeMap, HashSet};

use lopdf::{decode_text_string, dictionary, text_string, Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};

use crate::error::{PdfrsError, Result};

/// Outlines nested deeper than this are not followed.
const MAX_DEPTH: usize = 64;
/// Nor more entries than this (a malformed file could loop forever otherwise).
const MAX_ENTRIES: usize = 100_000;

/// One entry of the outline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub title: String,
    /// 1 for the top level; an entry's children follow it with its level + 1.
    pub level: u32,
    /// The page it points to (1-based), if it points to one of this document's.
    #[serde(default)]
    pub page: Option<u32>,
    /// Where on that page, in PDF units from the bottom (an `/XYZ` or `/FitH` top), if it says.
    #[serde(default)]
    pub top: Option<f64>,
    /// Whether its children show when the document opens.
    #[serde(default = "open_by_default")]
    pub open: bool,
    /// A web address it opens instead of a page (`/A` `/URI`), if it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// `#rrggbb` its title is shown in (`/C`), if not the reader's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Title in bold (`/F` bit 2).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    /// Title in italics (`/F` bit 1).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
}

impl OutlineEntry {
    /// An entry pointing at `page` (or nowhere), open, with no style.
    pub fn new(title: &str, level: u32, page: Option<u32>) -> Self {
        OutlineEntry {
            title: title.to_string(),
            level,
            page,
            top: None,
            open: true,
            uri: None,
            color: None,
            bold: false,
            italic: false,
        }
    }
}

fn open_by_default() -> bool {
    true
}

fn deref<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    doc.dereference(object).map(|(_, object)| object).unwrap_or(object)
}

fn dict_of<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    deref(doc, object).as_dict().ok()
}

/// A named destination, from the catalog's `/Dests` or the `/Names` → `/Dests` tree.
fn named_destination<'a>(doc: &'a Document, name: &[u8]) -> Option<&'a Object> {
    let catalog = doc.catalog().ok()?;
    if let Some(dests) = catalog.get(b"Dests").ok().and_then(|d| dict_of(doc, d)) {
        if let Ok(dest) = dests.get(name) {
            return Some(dest);
        }
    }
    let tree = catalog
        .get(b"Names")
        .ok()
        .and_then(|n| dict_of(doc, n))
        .and_then(|names| names.get(b"Dests").ok())
        .and_then(|d| dict_of(doc, d))?;
    find_in_name_tree(doc, tree, name, 0)
}

fn find_in_name_tree<'a>(doc: &'a Document, node: &'a Dictionary, name: &[u8], depth: usize) -> Option<&'a Object> {
    if depth > MAX_DEPTH {
        return None;
    }
    if let Ok(pairs) = node.get(b"Names").map(|n| deref(doc, n)).and_then(Object::as_array) {
        for pair in pairs.chunks(2) {
            if let [key, value] = pair {
                if deref(doc, key).as_str().ok() == Some(name) {
                    return Some(value);
                }
            }
        }
    }
    let kids = node.get(b"Kids").map(|k| deref(doc, k)).and_then(Object::as_array).ok()?;
    kids.iter()
        .filter_map(|kid| dict_of(doc, kid))
        .find_map(|kid| find_in_name_tree(doc, kid, name, depth + 1))
}

/// The page (1-based) and top a destination points to: an explicit array,
/// a name or string standing for one, or a dictionary holding it in `/D`.
fn resolve_destination(doc: &Document, dest: &Object, pages: &BTreeMap<ObjectId, u32>, depth: usize) -> (Option<u32>, Option<f64>) {
    if depth > 4 {
        return (None, None);
    }
    match deref(doc, dest) {
        Object::Array(items) => {
            let page = items.first().and_then(|first| first.as_reference().ok()).and_then(|id| pages.get(&id).copied());
            let kind = items.get(1).and_then(|k| k.as_name().ok());
            let number = |index: usize| items.get(index).and_then(|n| deref(doc, n).as_float().ok()).map(f64::from);
            let top = match kind {
                Some(b"XYZ") => number(3),
                Some(b"FitH" | b"FitBH") => number(2),
                _ => None,
            };
            (page, top)
        }
        Object::Name(name) => named_destination(doc, name).map_or((None, None), |d| resolve_destination(doc, d, pages, depth + 1)),
        Object::String(name, _) => {
            named_destination(doc, name).map_or((None, None), |d| resolve_destination(doc, d, pages, depth + 1))
        }
        Object::Dictionary(dict) => {
            dict.get(b"D").map_or((None, None), |d| resolve_destination(doc, d, pages, depth + 1))
        }
        _ => (None, None),
    }
}

/// The document's outline, entries in reading order with their levels;
/// empty when there is none.
pub fn read(doc: &Document) -> Vec<OutlineEntry> {
    let pages: BTreeMap<ObjectId, u32> = doc.get_pages().into_iter().map(|(number, id)| (id, number)).collect();
    let mut entries = Vec::new();
    let Some(first) = doc
        .catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Outlines").ok())
        .and_then(|outlines| dict_of(doc, outlines))
        .and_then(|outlines| outlines.get(b"First").ok())
        .and_then(|first| first.as_reference().ok())
    else {
        return entries;
    };
    walk(doc, first, 1, &pages, &mut HashSet::new(), &mut entries);
    entries
}

fn walk(
    doc: &Document,
    first: ObjectId,
    level: u32,
    pages: &BTreeMap<ObjectId, u32>,
    seen: &mut HashSet<ObjectId>,
    entries: &mut Vec<OutlineEntry>,
) {
    if level as usize > MAX_DEPTH {
        return;
    }
    let mut next = Some(first);
    while let Some(id) = next.take() {
        if !seen.insert(id) || entries.len() >= MAX_ENTRIES {
            return;
        }
        let Ok(item) = doc.get_dictionary(id) else { return };
        let title = item.get(b"Title").ok().and_then(|t| decode_text_string(deref(doc, t)).ok()).unwrap_or_default();
        let dest = item.get(b"Dest").ok().or_else(|| {
            // A GoTo action within the document (GoToR goes to another file: no page here).
            let action = item.get(b"A").ok().and_then(|a| dict_of(doc, a))?;
            (action.get(b"S").ok()?.as_name().ok()? == b"GoTo").then(|| action.get(b"D").ok()).flatten()
        });
        let (page, top) = dest.map_or((None, None), |d| resolve_destination(doc, d, pages, 0));
        let count = item.get(b"Count").ok().and_then(|c| deref(doc, c).as_i64().ok()).unwrap_or(0);
        let uri = item
            .get(b"A")
            .ok()
            .and_then(|a| dict_of(doc, a))
            .filter(|action| action.get(b"S").ok().and_then(|s| s.as_name().ok()) == Some(b"URI".as_ref()))
            .and_then(|action| action.get(b"URI").ok())
            .and_then(|uri| deref(doc, uri).as_str().ok())
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned());
        let color = item
            .get(b"C")
            .ok()
            .and_then(|c| deref(doc, c).as_array().ok())
            .and_then(|rgb| {
                let channel = |i: usize| rgb.get(i).and_then(|v| deref(doc, v).as_float().ok());
                let (r, g, b) = (channel(0)?, channel(1)?, channel(2)?);
                let byte = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                Some(format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b)))
            })
            // Black is what readers show anyway.
            .filter(|hex| hex != "#000000");
        let flags = item.get(b"F").ok().and_then(|f| deref(doc, f).as_i64().ok()).unwrap_or(0);
        entries.push(OutlineEntry {
            title,
            level,
            page,
            top,
            open: count >= 0,
            uri,
            color,
            bold: flags & 2 != 0,
            italic: flags & 1 != 0,
        });

        if let Some(child) = item.get(b"First").ok().and_then(|f| f.as_reference().ok()) {
            walk(doc, child, level + 1, pages, seen, entries);
        }
        next = item.get(b"Next").ok().and_then(|n| n.as_reference().ok());
    }
}

/// Replaces the document's outline with `entries` (an empty list removes
/// it). Levels are taken as written, except that one can't skip a level
/// (a 3 right after a 1 counts as a 2). An entry whose page isn't in the
/// document keeps its place, pointing nowhere.
pub fn write(doc: &mut Document, entries: &[OutlineEntry]) -> Result<()> {
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|_| PdfrsError::InvalidArgument("il documento non ha un catalogo".to_string()))?;
    let pages = doc.get_pages();

    // Normalised levels, and each entry's parent (None: the outline root).
    let mut levels = Vec::with_capacity(entries.len());
    let mut parents: Vec<Option<usize>> = Vec::with_capacity(entries.len());
    let mut stack: Vec<usize> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let previous = levels.last().copied().unwrap_or(0);
        let level = entry.level.max(1).min(previous + 1);
        while stack.last().is_some_and(|&open| levels[open] >= level) {
            stack.pop();
        }
        parents.push(stack.last().copied());
        levels.push(level);
        stack.push(index);
    }

    let root_id = doc.new_object_id();
    let ids: Vec<ObjectId> = entries.iter().map(|_| doc.new_object_id()).collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); entries.len()];
    let mut top_level = Vec::new();
    for (index, parent) in parents.iter().enumerate() {
        match parent {
            Some(parent) => children[*parent].push(index),
            None => top_level.push(index),
        }
    }

    // How many entries show under `index` if it is open (its children, and
    // theirs where those are open too).
    fn visible(index: usize, children: &[Vec<usize>], entries: &[OutlineEntry]) -> i64 {
        children[index].iter().map(|&child| 1 + if entries[child].open { visible(child, children, entries) } else { 0 }).sum()
    }

    let siblings = |list: &[usize], index: usize| {
        let at = list.iter().position(|&i| i == index).unwrap_or(0);
        (at.checked_sub(1).map(|p| list[p]), list.get(at + 1).copied())
    };

    for (index, entry) in entries.iter().enumerate() {
        let mut item = dictionary! {
            "Title" => text_string(&entry.title),
            "Parent" => parents[index].map_or(root_id, |p| ids[p]),
        };
        let list = parents[index].map_or(&top_level, |p| &children[p]);
        let (prev, next) = siblings(list, index);
        if let Some(prev) = prev {
            item.set("Prev", ids[prev]);
        }
        if let Some(next) = next {
            item.set("Next", ids[next]);
        }
        if let (Some(first), Some(last)) = (children[index].first(), children[index].last()) {
            item.set("First", ids[*first]);
            item.set("Last", ids[*last]);
            let count = visible(index, &children, entries);
            item.set("Count", if entry.open { count } else { -count });
        }
        if let Some(page_id) = entry.page.and_then(|page| pages.get(&page)) {
            let dest = match entry.top {
                Some(top) => vec![(*page_id).into(), "XYZ".into(), Object::Null, top.into(), Object::Null],
                None => vec![(*page_id).into(), "Fit".into()],
            };
            item.set("Dest", dest);
        } else if let Some(uri) = &entry.uri {
            item.set(
                "A",
                dictionary! {
                    "S" => "URI",
                    "URI" => Object::String(uri.as_bytes().to_vec(), lopdf::StringFormat::Literal),
                },
            );
        }
        if let Some(color) = &entry.color {
            let [r, g, b] = super::text::parse_color(color);
            item.set("C", vec![Object::Real(r as f32), Object::Real(g as f32), Object::Real(b as f32)]);
        }
        let flags = i64::from(entry.italic) | (i64::from(entry.bold) << 1);
        if flags != 0 {
            item.set("F", flags);
        }
        doc.objects.insert(ids[index], Object::Dictionary(item));
    }

    let catalog = doc.get_object_mut(catalog_id)?.as_dict_mut()?;
    if entries.is_empty() {
        catalog.remove(b"Outlines");
    } else {
        let mut root = dictionary! { "Type" => "Outlines" };
        if let (Some(first), Some(last)) = (top_level.first(), top_level.last()) {
            root.set("First", ids[*first]);
            root.set("Last", ids[*last]);
        }
        let shown: i64 = top_level.iter().map(|&i| 1 + if entries[i].open { visible(i, &children, entries) } else { 0 }).sum();
        root.set("Count", shown);
        catalog.set("Outlines", root_id);
        doc.objects.insert(root_id, Object::Dictionary(root));
    }
    // The old outline, now unreferenced.
    doc.prune_objects();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::test_support::multi_page_document;
    use lopdf::StringFormat;

    fn entry(title: &str, level: u32, page: Option<u32>) -> OutlineEntry {
        OutlineEntry::new(title, level, page)
    }

    #[test]
    fn keeps_links_colours_and_styles() {
        let mut doc = multi_page_document(2);
        let entries = vec![
            OutlineEntry { color: Some("#c00000".to_string()), bold: true, ..entry("Rosso", 1, Some(1)) },
            OutlineEntry { uri: Some("https://example.com/a?b=1".to_string()), ..entry("Sito", 1, None) },
            OutlineEntry { italic: true, ..entry("Corsivo", 2, Some(2)) },
        ];
        write(&mut doc, &entries).unwrap();

        assert_eq!(read(&reloaded(&mut doc)), entries);
    }

    #[test]
    fn a_page_wins_over_a_link() {
        let mut doc = multi_page_document(2);
        let both = OutlineEntry { uri: Some("https://example.com".to_string()), ..entry("Tutti e due", 1, Some(2)) };
        write(&mut doc, &[both]).unwrap();

        let read = read(&reloaded(&mut doc));
        assert_eq!((read[0].page, read[0].uri.as_deref()), (Some(2), None));
    }

    fn reloaded(doc: &mut Document) -> Document {
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        Document::load_mem(&bytes).unwrap()
    }

    #[test]
    fn writes_and_reads_back_an_outline() {
        let mut doc = multi_page_document(5);
        let entries = vec![
            entry("Introduzione", 1, Some(1)),
            OutlineEntry { top: Some(700.0), ..entry("Perché è così", 2, Some(2)) },
            OutlineEntry { open: false, ..entry("Capitolo 2 — «dettagli»", 1, Some(3)) },
            entry("Sezione chiusa sotto", 2, Some(4)),
            entry("Senza pagina", 1, None),
        ];
        write(&mut doc, &entries).unwrap();
        assert_eq!(read(&reloaded(&mut doc)), entries);
    }

    #[test]
    fn writes_counts_for_open_and_closed_branches() {
        let mut doc = multi_page_document(3);
        write(&mut doc, &[entry("A", 1, Some(1)), entry("A.1", 2, Some(2)), OutlineEntry { open: false, ..entry("B", 1, Some(3)) }, entry("B.1", 2, Some(3))]).unwrap();
        let catalog = doc.catalog().unwrap();
        let root = doc.get_dictionary(catalog.get(b"Outlines").unwrap().as_reference().unwrap()).unwrap();
        // A, A.1 and B show; B.1 is inside a closed branch.
        assert_eq!(root.get(b"Count").unwrap().as_i64().unwrap(), 3);
    }

    #[test]
    fn normalises_skipped_levels_and_removes_with_an_empty_list() {
        let mut doc = multi_page_document(2);
        write(&mut doc, &[entry("A", 1, Some(1)), entry("A.x.y", 3, Some(2))]).unwrap();
        assert_eq!(read(&doc).iter().map(|e| e.level).collect::<Vec<_>>(), vec![1, 2]);

        write(&mut doc, &[]).unwrap();
        assert!(read(&doc).is_empty());
        assert!(doc.catalog().unwrap().get(b"Outlines").is_err());
        assert!(!doc.objects.values().any(|o| o.as_dict().is_ok_and(|d| d.has(b"Title"))), "the old entries are gone");
    }

    /// An outline the way other producers write them: a GoTo action, named
    /// destinations (from /Dests and from the /Names tree), a UTF-16 title,
    /// and a destination that leads nowhere.
    #[test]
    fn reads_actions_named_destinations_and_broken_ones() {
        let mut doc = multi_page_document(3);
        let pages = doc.get_pages();
        let (p1, p2, p3) = (pages[&1], pages[&2], pages[&3]);
        let tree = doc.add_object(dictionary! {
            "Names" => vec![Object::string_literal("terza"), vec![p3.into(), "FitH".into(), 500.into()].into()],
        });
        let catalog_id = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let root = doc.new_object_id();
        let ids: Vec<ObjectId> = (0..4).map(|_| doc.new_object_id()).collect();
        let utf16: Vec<u8> = vec![0xFEu8, 0xFF].into_iter().chain("Città".encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
        doc.objects.insert(ids[0], Object::Dictionary(dictionary! {
            "Title" => Object::String(utf16, StringFormat::Hexadecimal), "Parent" => root, "Next" => ids[1],
            "A" => dictionary! { "S" => "GoTo", "D" => vec![p1.into(), "Fit".into()] },
        }));
        doc.objects.insert(ids[1], Object::Dictionary(dictionary! {
            "Title" => Object::string_literal("Con nome"), "Parent" => root, "Prev" => ids[0], "Next" => ids[2],
            "Dest" => Object::Name(b"seconda".to_vec()),
        }));
        doc.objects.insert(ids[2], Object::Dictionary(dictionary! {
            "Title" => Object::string_literal("Dall'albero"), "Parent" => root, "Prev" => ids[1], "Next" => ids[3],
            "Dest" => Object::string_literal("terza"),
        }));
        doc.objects.insert(ids[3], Object::Dictionary(dictionary! {
            "Title" => Object::string_literal("Rotta"), "Parent" => root, "Prev" => ids[2],
            "Dest" => Object::Name(b"inesistente".to_vec()),
        }));
        doc.objects.insert(root, Object::Dictionary(dictionary! { "Type" => "Outlines", "First" => ids[0], "Last" => ids[3], "Count" => 4 }));
        let catalog = doc.get_object_mut(catalog_id).unwrap().as_dict_mut().unwrap();
        catalog.set("Outlines", root);
        catalog.set("Dests", dictionary! { "seconda" => vec![p2.into(), "XYZ".into(), 0.into(), 640.into(), Object::Null] });
        catalog.set("Names", dictionary! { "Dests" => tree });

        let read = read(&doc);
        let summary: Vec<_> = read.iter().map(|e| (e.title.as_str(), e.page, e.top)).collect();
        assert_eq!(
            summary,
            vec![("Città", Some(1), None), ("Con nome", Some(2), Some(640.0)), ("Dall'albero", Some(3), Some(500.0)), ("Rotta", None, None)]
        );
    }

    /// The page operations don't carry the outline over: the model writes it
    /// back, remapped (see PdfDocument). This pins down why it has to.
    #[test]
    fn compose_and_merge_leave_the_outline_out() {
        use crate::operations::compose::{compose, PageRef};
        use crate::operations::merge::merge;
        let mut doc = multi_page_document(2);
        write(&mut doc, &[entry("A", 1, Some(1))]).unwrap();
        let composed = compose(vec![doc.clone()], &[PageRef { source: 0, page: 2 }]).unwrap();
        assert!(read(&composed).is_empty());
        assert!(read(&merge(vec![doc.clone(), doc]).unwrap()).is_empty());
    }

    #[test]
    fn a_document_without_an_outline_has_none() {
        assert!(read(&multi_page_document(2)).is_empty());
    }
}
