//! Content streams read as bytes, without re-encoding them.
//!
//! lopdf's `Content::decode` + `encode` round trip loses data: inline images
//! (`BI … ID <data> EI`) with a filter are dropped while decoding, and the
//! ones that survive are written back in a syntax no reader accepts. So
//! anything that edits a page that may hold content we didn't write works
//! on the bytes instead: this scanner finds each operation and the exact
//! byte range it occupies, an edit cuts or adds bytes, and everything else
//! stays byte for byte as it was.
//!
//! It understands just enough of the syntax to never mistake data for an
//! operator: literal strings (nested parentheses, escapes), hex strings,
//! comments, arrays and dictionaries, and the binary data of inline images.

use std::ops::Range;

use lopdf::{Document, ObjectId, Stream, dictionary};

use crate::error::Result;

/// An operand, kept only as far as callers need it.
#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    Number(f64),
    Name(Vec<u8>),
    /// Anything else (strings, arrays, dictionaries, booleans, null).
    Other,
}

/// An inline image: its dictionary as written (abbreviated keys and all)
/// and where its data lies.
#[derive(Debug, Clone, PartialEq)]
pub struct InlineImage {
    pub entries: Vec<(Vec<u8>, Operand)>,
    pub data: Range<usize>,
}

impl InlineImage {
    /// The value of the first of `keys` present (e.g. `["W", "Width"]`).
    pub fn get(&self, keys: &[&str]) -> Option<&Operand> {
        keys.iter()
            .find_map(|key| self.entries.iter().find(|(k, _)| k == key.as_bytes()).map(|(_, v)| v))
    }
}

/// One operation: the operator, its operands, and the bytes it spans - from
/// its first operand to the end of the operator (for an inline image, from
/// `BI` to the end of `EI`).
#[derive(Debug, Clone, PartialEq)]
pub struct Op {
    pub operator: String,
    pub operands: Vec<Operand>,
    pub span: Range<usize>,
    pub inline_image: Option<InlineImage>,
}

fn is_whitespace(byte: u8) -> bool {
    matches!(byte, b'\0' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn is_delimiter(byte: u8) -> bool {
    matches!(byte, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

fn is_regular(byte: u8) -> bool {
    !is_whitespace(byte) && !is_delimiter(byte)
}

/// What the tokenizer found next.
enum Token {
    Operand(Operand),
    /// A bare word: an operator, or `true`/`false`/`null`.
    Word(Vec<u8>),
}

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn skip_whitespace_and_comments(&mut self) {
        while self.pos < self.bytes.len() {
            let byte = self.bytes[self.pos];
            if is_whitespace(byte) {
                self.pos += 1;
            } else if byte == b'%' {
                while self.pos < self.bytes.len() && !matches!(self.bytes[self.pos], b'\n' | b'\r') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// The next token and where it starts, or None at the end.
    fn next(&mut self) -> Option<(usize, Token)> {
        self.skip_whitespace_and_comments();
        let start = self.pos;
        let byte = *self.bytes.get(self.pos)?;
        let token = match byte {
            b'(' => {
                self.skip_literal_string();
                Token::Operand(Operand::Other)
            }
            b'<' if self.bytes.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                self.skip_until_close(b">>");
                Token::Operand(Operand::Other)
            }
            b'<' => {
                self.pos += 1;
                while self.pos < self.bytes.len() && self.bytes[self.pos] != b'>' {
                    self.pos += 1;
                }
                self.pos = (self.pos + 1).min(self.bytes.len());
                Token::Operand(Operand::Other)
            }
            b'[' => {
                self.pos += 1;
                self.skip_until_close(b"]");
                Token::Operand(Operand::Other)
            }
            b'{' => {
                self.pos += 1;
                self.skip_until_close(b"}");
                Token::Operand(Operand::Other)
            }
            b'/' => {
                self.pos += 1;
                let begin = self.pos;
                while self.pos < self.bytes.len() && is_regular(self.bytes[self.pos]) {
                    self.pos += 1;
                }
                Token::Operand(Operand::Name(decode_name(&self.bytes[begin..self.pos])))
            }
            // Stray closers: skip them rather than loop forever.
            b')' | b'>' | b']' | b'}' => {
                self.pos += 1;
                Token::Operand(Operand::Other)
            }
            _ => {
                while self.pos < self.bytes.len() && is_regular(self.bytes[self.pos]) {
                    self.pos += 1;
                }
                let word = &self.bytes[start..self.pos];
                match std::str::from_utf8(word).ok().and_then(|text| text.parse::<f64>().ok()) {
                    Some(number) if word.iter().all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.')) => {
                        Token::Operand(Operand::Number(number))
                    }
                    _ => Token::Word(word.to_vec()),
                }
            }
        };
        Some((start, token))
    }

    /// Past a literal string, `(` included: nested parentheses balance,
    /// a backslash escapes the next byte.
    fn skip_literal_string(&mut self) {
        let mut depth = 0usize;
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b'\\' => self.pos += 1,
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        self.pos += 1;
                        return;
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
    }

    /// Past the matching `close`, skipping nested structures and strings.
    fn skip_until_close(&mut self, close: &[u8]) {
        loop {
            self.skip_whitespace_and_comments();
            if self.pos >= self.bytes.len() {
                return;
            }
            if self.bytes[self.pos..].starts_with(close) {
                self.pos += close.len();
                return;
            }
            // Any token, nested ones included, moves past itself.
            if self.next().is_none() {
                return;
            }
        }
    }

    /// After `BI`: the dictionary up to `ID`, then the data up to `EI`.
    fn inline_image(&mut self) -> InlineImage {
        let mut entries = Vec::new();
        let mut key: Option<Vec<u8>> = None;
        while let Some((_, token)) = self.next() {
            match token {
                Token::Word(word) if word == b"ID" => break,
                Token::Operand(Operand::Name(name)) if key.is_none() => key = Some(name),
                Token::Operand(value) => {
                    if let Some(k) = key.take() {
                        entries.push((k, value));
                    }
                }
                Token::Word(_) => {
                    // true/false/null as a value.
                    if let Some(k) = key.take() {
                        entries.push((k, Operand::Other));
                    }
                }
            }
        }
        // One whitespace byte separates ID from the data.
        if self.bytes.get(self.pos).copied().is_some_and(is_whitespace) {
            self.pos += 1;
        }
        let begin = self.pos;
        let image = InlineImage { entries, data: begin..begin };

        let declared = image.get(&["L", "Length"]).and_then(|value| match value {
            Operand::Number(n) if *n >= 0.0 => Some(*n as usize),
            _ => None,
        });
        let end = match declared {
            Some(length) if begin + length <= self.bytes.len() => {
                let after = begin + length;
                let mut probe = after;
                while probe < self.bytes.len() && is_whitespace(self.bytes[probe]) {
                    probe += 1;
                }
                if self.bytes[probe..].starts_with(b"EI") { Some((after, probe + 2)) } else { None }
            }
            _ => None,
        }
        .or_else(|| find_inline_end(self.bytes, begin));

        match end {
            Some((data_end, after_ei)) => {
                self.pos = after_ei;
                InlineImage { data: begin..data_end, ..image }
            }
            None => {
                self.pos = self.bytes.len();
                InlineImage { data: begin..self.bytes.len(), ..image }
            }
        }
    }
}

/// Where inline image data ends without a declared length: the first `EI`
/// preceded by whitespace and followed by whitespace or the end, since the
/// data itself may contain those two letters anywhere else.
fn find_inline_end(bytes: &[u8], begin: usize) -> Option<(usize, usize)> {
    let mut index = begin;
    while index + 2 <= bytes.len() {
        if &bytes[index..index + 2] == b"EI"
            && index > begin
            && is_whitespace(bytes[index - 1])
            && bytes.get(index + 2).is_none_or(|&b| is_whitespace(b))
        {
            return Some((index - 1, index + 2));
        }
        index += 1;
    }
    None
}

/// `#xx` escapes in a name decoded.
fn decode_name(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'#' && index + 3 <= raw.len() {
            if let Some(value) = std::str::from_utf8(&raw[index + 1..index + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(raw[index]);
        index += 1;
    }
    out
}

/// Every operation in `bytes`, in order.
pub fn scan(bytes: &[u8]) -> Vec<Op> {
    let mut scanner = Scanner { bytes, pos: 0 };
    let mut ops = Vec::new();
    let mut operands = Vec::new();
    let mut first: Option<usize> = None;

    while let Some((start, token)) = scanner.next() {
        match token {
            Token::Operand(operand) => {
                first.get_or_insert(start);
                operands.push(operand);
            }
            Token::Word(word) if matches!(word.as_slice(), b"true" | b"false" | b"null") => {
                first.get_or_insert(start);
                operands.push(Operand::Other);
            }
            Token::Word(word) => {
                let begin = first.take().unwrap_or(start);
                let inline_image = (word == b"BI").then(|| scanner.inline_image());
                ops.push(Op {
                    operator: String::from_utf8_lossy(&word).into_owned(),
                    operands: std::mem::take(&mut operands),
                    span: begin..scanner.pos,
                    inline_image,
                });
            }
        }
    }
    ops
}

/// `bytes` with the given ranges cut out (each replaced by one space, so
/// the tokens on either side stay apart). Ranges must not overlap.
pub fn cut(bytes: &[u8], ranges: &[Range<usize>]) -> Vec<u8> {
    let mut sorted: Vec<&Range<usize>> = ranges.iter().collect();
    sorted.sort_by_key(|range| range.start);
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    for range in sorted {
        out.extend_from_slice(&bytes[at..range.start]);
        out.push(b' ');
        at = range.end;
    }
    out.extend_from_slice(&bytes[at..]);
    out
}

/// Gives a page new content, as a new stream of its own. Never rewrites the
/// page's current stream in place: a content stream can be shared by
/// several pages, and `Document::change_page_content` would change them all.
pub fn set_page_content(doc: &mut Document, page_id: ObjectId, content: Vec<u8>) -> Result<()> {
    let mut stream = Stream::new(dictionary! {}, content);
    // Smaller is better, but a stream that doesn't shrink stays as it is.
    let _ = stream.compress();
    let stream_id = doc.add_object(stream);
    doc.get_object_mut(page_id)?.as_dict_mut()?.set("Contents", stream_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operators(bytes: &[u8]) -> Vec<String> {
        scan(bytes).into_iter().map(|op| op.operator).collect()
    }

    #[test]
    fn finds_operators_and_their_operands() {
        let ops = scan(b"q 1 0 0 1 50.5 -20 cm /Im0 Do Q");
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[1].operator, "cm");
        assert_eq!(ops[1].operands[4], Operand::Number(50.5));
        assert_eq!(ops[1].operands[5], Operand::Number(-20.0));
        assert_eq!(ops[2].operands, vec![Operand::Name(b"Im0".to_vec())]);
        assert_eq!(&b"q 1 0 0 1 50.5 -20 cm /Im0 Do Q"[ops[2].span.clone()], b"/Im0 Do");
    }

    #[test]
    fn never_reads_an_operator_inside_strings_comments_or_arrays() {
        let bytes = b"BT (a (nested) Do \\) string) Tj <446f> Tj [(x) 120 (Do)] TJ ET % /Im0 Do\n/X#20Y Do";
        assert_eq!(operators(bytes), vec!["BT", "Tj", "Tj", "TJ", "ET", "Do"]);
        assert_eq!(scan(bytes)[5].operands, vec![Operand::Name(b"X Y".to_vec())]);
    }

    #[test]
    fn skips_dictionaries_given_as_operands() {
        let ops = scan(b"/OC <</MCID 3 /Alt (a >> b)>> BDC /Im1 Do EMC");
        assert_eq!(ops.iter().map(|op| op.operator.as_str()).collect::<Vec<_>>(), vec!["BDC", "Do", "EMC"]);
    }

    #[test]
    fn reads_an_inline_image_with_ei_inside_its_data() {
        // The data holds "EI" and an "Do", neither of which ends anything.
        let mut bytes = b"q 10 0 0 10 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID ".to_vec();
        let data_start = bytes.len();
        bytes.extend_from_slice(b"EIx Do>");
        let data_end = bytes.len();
        bytes.extend_from_slice(b"\nEI Q /Im0 Do");

        let ops = scan(&bytes);
        assert_eq!(operators(&bytes), vec!["q", "cm", "BI", "Q", "Do"]);
        let image = ops[2].inline_image.as_ref().unwrap();
        assert_eq!(image.get(&["W", "Width"]), Some(&Operand::Number(2.0)));
        assert_eq!(image.get(&["F", "Filter"]), Some(&Operand::Name(b"AHx".to_vec())));
        assert_eq!(image.data, data_start..data_end);
        assert!(bytes[ops[2].span.clone()].starts_with(b"BI"));
        assert!(bytes[ops[2].span.clone()].ends_with(b"EI"));
    }

    #[test]
    fn uses_a_declared_inline_length() {
        let bytes = b"BI /W 1 /H 1 /L 4 ID EI E\nEI /A Do";
        let ops = scan(bytes);
        assert_eq!(operators(bytes), vec!["BI", "Do"]);
        assert_eq!(&bytes[ops[0].inline_image.as_ref().unwrap().data.clone()], b"EI E");
    }

    #[test]
    fn cuts_ranges_and_leaves_the_rest_untouched() {
        let bytes = b"q /A Do Q q /B Do Q";
        let ops = scan(bytes);
        let out = cut(bytes, &[ops[1].span.clone()]);
        assert_eq!(out, b"q   Q q /B Do Q");
        assert_eq!(operators(&out), vec!["q", "Q", "q", "Do", "Q"]);
    }
}
