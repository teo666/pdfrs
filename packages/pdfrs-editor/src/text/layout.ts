// The same text layout as the engine (src/operations/text.rs in pdfrs), so a
// UI can draw a text annotation's box - and the text in it - exactly where
// and as big as the PDF will have it. Keep the two in step: same metrics
// (generated from the same tables), same line height, padding and baseline.
import * as metrics from "./metrics";

export type StandardFont = "helvetica" | "times" | "courier";
export type TextAlign = "left" | "center" | "right";

/** How a text annotation looks. */
export interface TextStyle {
  font: StandardFont;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb`. */
  color: string;
  align: TextAlign;
}

/** A text annotation's content: the text, and how it looks. */
export interface TextContent extends TextStyle {
  text: string;
}

/** Line spacing, in em. */
export const LINE_HEIGHT = 1.2;
/** Room left and right of the longest line, in em. */
export const PAD = 0.1;
const BASELINE_FROM_MIDDLE = (0.72 - 0.21) / 2;

export interface TextLayout {
  /** The lines, as written (blank lines kept, trailing ones dropped). */
  lines: string[];
  /** Width of each line, in em. */
  lineWidths: number[];
  /** Size of the whole box at a font size of 1, in em. */
  width: number;
  height: number;
}

const SPECIAL: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f, "\t": 0x20,
};

/** The WinAnsi code a character is written with; `?` (63) for the ones the standard fonts lack. */
export function winAnsiCode(char: string): number {
  const code = char.codePointAt(0) ?? 63;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return SPECIAL[char] ?? 63;
}

/** True when every character can be written in the standard fonts (else some show as `?`). */
export function isWinAnsi(text: string): boolean {
  return [...text.replace(/\r?\n/g, "")].every((char) => winAnsiCode(char) !== 63 || char === "?");
}

function widths(style: Pick<TextStyle, "font" | "bold" | "italic">): readonly number[] | null {
  if (style.font === "courier") return null;
  if (style.font === "helvetica") return style.bold ? metrics.HELVETICA_BOLD : metrics.HELVETICA;
  if (style.bold) return style.italic ? metrics.TIMES_BOLD_ITALIC : metrics.TIMES_BOLD;
  return style.italic ? metrics.TIMES_ITALIC : metrics.TIMES_ROMAN;
}

/** Lays text out like the engine does. */
export function layoutText(text: string, style: Pick<TextStyle, "font" | "bold" | "italic">): TextLayout {
  const table = widths(style);
  const lines = text.replace(/[\n\r \t]+$/, "").split("\n").map((line) => line.replace(/\r$/, ""));
  const lineWidths = lines.map((line) =>
    [...line].reduce((sum, char) => {
      const code = winAnsiCode(char);
      return sum + (table ? (table[code - 32] ?? 0) / 1000 : 0.6);
    }, 0),
  );
  return {
    lines,
    lineWidths,
    width: Math.max(0, ...lineWidths) + 2 * PAD,
    height: lines.length * LINE_HEIGHT,
  };
}

/** Where line `index` starts, in em: x of its left end, y of its baseline from the box's top. */
export function lineOrigin(layout: TextLayout, index: number, align: TextAlign): { x: number; y: number } {
  const free = layout.width - 2 * PAD - (layout.lineWidths[index] ?? 0);
  const x = PAD + (align === "left" ? 0 : align === "center" ? free / 2 : free);
  return { x, y: (index + 0.5) * LINE_HEIGHT + BASELINE_FROM_MIDDLE };
}

/** A CSS font-family close to each standard font (metric-compatible where available). */
export const CSS_FONT: Record<StandardFont, string> = {
  helvetica: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  times: "'Times New Roman', Times, 'Liberation Serif', serif",
  courier: "'Courier New', Courier, 'Liberation Mono', monospace",
};
