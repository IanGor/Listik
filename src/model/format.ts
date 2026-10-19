/**
 * Inline formatting, Markdown style, in a bullet's plain text: `**bold**`,
 * `*italic*` or `_italic_`. The text keeps its markers (exports stay
 * Markdown); the static view hides them and styles what they enclose.
 */

/** Per character: part of a bold or italic run, or a marker itself. */
export const BOLD = 1;
export const ITALIC = 2;
export const MARKER = 4;

// A marker opens before a non-space and closes after one, at word edges:
// "2*3*4", snake_case and a lone "*" stay as they are. Bold may hold an
// italic run right at its edges: `***both***`, `**a *b***`.
const BOLD_RE = /(?<![\p{L}\p{N}*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\p{L}\p{N}*])/gu;
const ITALIC_RE = /(?<![\p{L}\p{N}*_])([*_])(?!\1)(?=\S)(.+?)(?<=\S)(?<!\1\1)\1(?![\p{L}\p{N}*_])/gu;

/** Formatting flags of each character (BOLD, ITALIC, MARKER); null when the text has none. */
export function formatFlags(text: string): Uint8Array | null {
  if (!text.includes('*') && !text.includes('_')) return null;
  let flags: Uint8Array | null = null;
  const mark = (source: string, re: RegExp, style: number, marker: number) => {
    for (const m of source.matchAll(re)) {
      flags ??= new Uint8Array(text.length);
      const start = m.index;
      const end = start + m[0].length;
      for (let i = start; i < end; i++) flags[i] |= i < start + marker || i >= end - marker ? MARKER : style;
    }
  };
  mark(text, BOLD_RE, BOLD, 2);
  // Italic is looked for with bold's markers blanked out (same length, so
  // offsets hold): they neither open nor glue to an italic run.
  let source = text;
  const bold = flags as Uint8Array | null;
  if (bold) {
    source = '';
    for (let i = 0; i < text.length; i++) source += bold[i] & MARKER ? ' ' : text[i];
  }
  mark(source, ITALIC_RE, ITALIC, 1);
  return flags;
}

/** The text as it reads, markers dropped: for places that show it plain (breadcrumbs). */
export function plainText(text: string): string {
  const flags = formatFlags(text);
  if (!flags) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) if (!(flags[i] & MARKER)) out += text[i];
  return out;
}

/**
 * Bold or italic on and off around a selection (Ctrl+B / Ctrl+I): the
 * new text and the selection inside the markers. Already wrapped in exactly
 * this marker, it is unwrapped.
 */
export function toggleFormat(text: string, start: number, end: number, marker: '**' | '*'): { text: string; start: number; end: number } {
  const n = marker.length;
  // The run of `*` at each edge says what is on: an odd run (`*`, `***`) has
  // italic, a run of two or more has bold.
  let before = 0;
  while (before < 3 && text[start - before - 1] === '*') before++;
  let after = 0;
  while (after < 3 && text[end + after] === '*') after++;
  const wrapped = n === 2 ? before >= 2 && after >= 2 : before % 2 === 1 && after % 2 === 1;
  if (wrapped) return { text: text.slice(0, start - n) + text.slice(start, end) + text.slice(end + n), start: start - n, end: end - n };
  return { text: text.slice(0, start) + marker + text.slice(start, end) + marker + text.slice(end), start: start + n, end: end + n };
}
