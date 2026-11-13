//! Text set in the PDF standard fonts - Helvetica, Times and Courier, each
//! regular/bold/italic/bold-italic. Every PDF reader has these built in, so
//! nothing is embedded: the text stays real text (selectable, searchable,
//! sharp at any zoom) and costs a few bytes.
//!
//! The price is the character set: WinAnsiEncoding, i.e. Western European
//! Latin. Italian is fully covered (accents, «», €); anything else comes out
//! as `?`. Full Unicode needs an embedded font, which this module doesn't do.

use serde::Deserialize;

use super::text_metrics;

/// One of the three standard families.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StandardFont {
    #[default]
    Helvetica,
    Times,
    Courier,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// A family plus weight and slant: one of the 12 fonts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FontFace {
    pub family: StandardFont,
    pub bold: bool,
    pub italic: bool,
}

impl FontFace {
    /// The PostScript name every PDF reader knows the font by.
    pub fn base_font(self) -> &'static str {
        use StandardFont::*;
        match (self.family, self.bold, self.italic) {
            (Helvetica, false, false) => "Helvetica",
            (Helvetica, true, false) => "Helvetica-Bold",
            (Helvetica, false, true) => "Helvetica-Oblique",
            (Helvetica, true, true) => "Helvetica-BoldOblique",
            (Times, false, false) => "Times-Roman",
            (Times, true, false) => "Times-Bold",
            (Times, false, true) => "Times-Italic",
            (Times, true, true) => "Times-BoldItalic",
            (Courier, false, false) => "Courier",
            (Courier, true, false) => "Courier-Bold",
            (Courier, false, true) => "Courier-Oblique",
            (Courier, true, true) => "Courier-BoldOblique",
        }
    }

    /// Advance width of a WinAnsi code, in em.
    fn width(self, code: u8) -> f64 {
        use StandardFont::*;
        let table = match (self.family, self.bold, self.italic) {
            // Courier is monospaced; the oblique Helveticas share the
            // upright ones' widths.
            (Courier, _, _) => return 0.6,
            (Helvetica, false, _) => &text_metrics::HELVETICA,
            (Helvetica, true, _) => &text_metrics::HELVETICA_BOLD,
            (Times, false, false) => &text_metrics::TIMES_ROMAN,
            (Times, true, false) => &text_metrics::TIMES_BOLD,
            (Times, false, true) => &text_metrics::TIMES_ITALIC,
            (Times, true, true) => &text_metrics::TIMES_BOLD_ITALIC,
        };
        match code {
            32..=255 => table[(code - 32) as usize] as f64 / 1000.0,
            _ => 0.0,
        }
    }
}

/// Line spacing, in em.
pub const LINE_HEIGHT: f64 = 1.2;
/// Room left of and right of the longest line, in em - italics overhang.
pub const PAD: f64 = 0.1;
/// Where a line's baseline sits below the middle of its line box, in em: half
/// of a typical ascender (0.72) plus descender (-0.21), so the ink is centred.
const BASELINE_FROM_MIDDLE: f64 = (0.72 - 0.21) / 2.0;

/// Text laid out at a font size of 1, in em: lines encoded for the font, with
/// their widths, and the size of the whole box.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLayout {
    pub lines: Vec<Vec<u8>>,
    pub line_widths: Vec<f64>,
    pub width: f64,
    pub height: f64,
}

/// Lays out `text` (lines split on `\n`, trailing blank lines dropped).
pub fn layout(text: &str, face: FontFace) -> TextLayout {
    let trimmed = text.trim_end_matches(['\n', '\r', ' ', '\t']);
    let lines: Vec<Vec<u8>> = trimmed
        .split('\n')
        .map(|line| encode_win_ansi(line.trim_end_matches('\r')))
        .collect();
    let line_widths: Vec<f64> = lines
        .iter()
        .map(|line| line.iter().map(|&code| face.width(code)).sum())
        .collect();
    let longest = line_widths.iter().cloned().fold(0.0, f64::max);
    TextLayout {
        width: longest + 2.0 * PAD,
        height: lines.len() as f64 * LINE_HEIGHT,
        lines,
        line_widths,
    }
}

impl TextLayout {
    /// Where line `index` starts: (x of its left end, y of its baseline), in em
    /// within the box, y growing upwards from the box's bottom as in PDF.
    pub fn line_origin(&self, index: usize, align: TextAlign) -> (f64, f64) {
        let free = self.width - 2.0 * PAD - self.line_widths[index];
        let x = PAD
            + match align {
                TextAlign::Left => 0.0,
                TextAlign::Center => free / 2.0,
                TextAlign::Right => free,
            };
        let middle = self.height - (index as f64 + 0.5) * LINE_HEIGHT;
        (x, middle - BASELINE_FROM_MIDDLE)
    }
}

/// Unicode to WinAnsiEncoding (Windows-1252). Characters it lacks become `?`.
pub fn encode_win_ansi(text: &str) -> Vec<u8> {
    text.chars()
        .map(|ch| {
            let code = ch as u32;
            match code {
                0x20..=0x7E | 0xA0..=0xFF => code as u8,
                _ => match ch {
                    '€' => 0x80,
                    '‚' => 0x82,
                    'ƒ' => 0x83,
                    '„' => 0x84,
                    '…' => 0x85,
                    '†' => 0x86,
                    '‡' => 0x87,
                    'ˆ' => 0x88,
                    '‰' => 0x89,
                    'Š' => 0x8A,
                    '‹' => 0x8B,
                    'Œ' => 0x8C,
                    'Ž' => 0x8E,
                    '\u{2018}' => 0x91,
                    '\u{2019}' => 0x92,
                    '\u{201C}' => 0x93,
                    '\u{201D}' => 0x94,
                    '•' => 0x95,
                    '–' => 0x96,
                    '—' => 0x97,
                    '˜' => 0x98,
                    '™' => 0x99,
                    'š' => 0x9A,
                    '›' => 0x9B,
                    'œ' => 0x9C,
                    'ž' => 0x9E,
                    'Ÿ' => 0x9F,
                    '\t' => b' ',
                    _ => b'?',
                },
            }
        })
        .collect()
}

/// `#rrggbb` (or `#rgb`) to PDF's 0..1 RGB. Anything else is black.
pub fn parse_color(color: &str) -> [f64; 3] {
    let hex = color.trim().trim_start_matches('#');
    let full: String = match hex.len() {
        3 => hex.chars().flat_map(|c| [c, c]).collect(),
        6 => hex.to_string(),
        _ => return [0.0, 0.0, 0.0],
    };
    let channel = |i: usize| u8::from_str_radix(&full[i..i + 2], 16).map(|v| v as f64 / 255.0);
    match (channel(0), channel(2), channel(4)) {
        (Ok(r), Ok(g), Ok(b)) => [r, g, b],
        _ => [0.0, 0.0, 0.0],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELVETICA: FontFace = FontFace {
        family: StandardFont::Helvetica,
        bold: false,
        italic: false,
    };

    #[test]
    fn encodes_italian_text_and_replaces_what_winansi_lacks() {
        assert_eq!(
            encode_win_ansi("è più così €"),
            vec![0xE8, b' ', b'p', b'i', 0xF9, b' ', b'c', b'o', b's', 0xEC, b' ', 0x80]
        );
        assert_eq!(
            encode_win_ansi("«ok» – “sì”"),
            vec![0xAB, b'o', b'k', 0xBB, b' ', 0x96, b' ', 0x93, b's', 0xEC, 0x94]
        );
        assert_eq!(encode_win_ansi("Ωж😀"), b"???".to_vec());
    }

    #[test]
    fn measures_with_the_adobe_metrics() {
        // Helvetica: "H" 722, "i" 222 (in 1/1000 em).
        let layout = layout("Hi", HELVETICA);
        assert!((layout.line_widths[0] - 0.944).abs() < 1e-9);
        assert!((layout.width - (0.944 + 2.0 * PAD)).abs() < 1e-9);
        // Courier: every character is 600.
        let courier = layout_of("Hi!", StandardFont::Courier);
        assert!((courier.line_widths[0] - 1.8).abs() < 1e-9);
        // Bold is wider than regular.
        let bold = super::layout(
            "Hi",
            FontFace {
                bold: true,
                ..HELVETICA
            },
        );
        assert!(bold.line_widths[0] > layout.line_widths[0]);
    }

    fn layout_of(text: &str, family: StandardFont) -> TextLayout {
        super::layout(
            text,
            FontFace {
                family,
                bold: false,
                italic: false,
            },
        )
    }

    #[test]
    fn lays_out_lines_and_aligns_them() {
        let layout = layout("Hello\nHi\n\n", HELVETICA);
        assert_eq!(layout.lines.len(), 2, "trailing blank lines are dropped");
        assert!((layout.height - 2.0 * LINE_HEIGHT).abs() < 1e-9);

        let (left_x, first_y) = layout.line_origin(1, TextAlign::Left);
        let (right_x, second_y) = layout.line_origin(1, TextAlign::Right);
        let (centre_x, _) = layout.line_origin(1, TextAlign::Center);
        assert_eq!(left_x, PAD);
        assert!((right_x + layout.line_widths[1] - (layout.width - PAD)).abs() < 1e-9);
        assert!((centre_x - (left_x + right_x) / 2.0).abs() < 1e-9);
        assert_eq!(first_y, second_y);
        // The first line is above the second.
        assert!(layout.line_origin(0, TextAlign::Left).1 > first_y);
    }

    #[test]
    fn reads_colours() {
        assert_eq!(parse_color("#ff0000"), [1.0, 0.0, 0.0]);
        assert_eq!(parse_color("#00f"), [0.0, 0.0, 1.0]);
        assert_eq!(parse_color("rosso"), [0.0, 0.0, 0.0]);
    }
}
