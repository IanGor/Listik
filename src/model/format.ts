/**
 * Inline formatting, Markdown style, in a bullet's plain text: `**bold**`,
 * `*italic*` or `_italic_`, `[[links]]` to other bullets (model/links.ts),
 * and web addresses. The text keeps its markers (exports stay Markdown);
 * the static view hides them and styles what they enclose.
 */

/** Per character: part of a bold or italic run, a link or a web address, or a marker itself. */
export const BOLD = 1;
export const ITALIC = 2;
export const MARKER = 4;
export const LINK = 8;
/** 16 is search's HIT (search.ts). */
export const URL = 32;

/**
 * A web address: `http://`, `https://` or `www.` up to a space, a quote or a
 * bracket. What ends a sentence is left out (`site.ru.`, `site.ru,`), and so
 * are formatting markers (`**site.ru**`) and a closing parenthesis without
 * its opening one inside: `(see site.ru)`.
 */
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`[\]{}«»]+/gi;
const TRAILING = /[.,;:!?…'"»*_]$/;

/**
 * A Markdown link, `[words](address)`: words of one's own leading to a web
 * address. Not the inner brackets of a `[[link]]`; the address has no spaces
 * or parentheses (linkOver writes them as %28 %29).
 */
const MD_LINK_RE = /(?<!\[)\[(?=[^[\]\n]*[^[\]\s])([^[\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s()<>]+)\)/gi;
const ADDRESS_RE = /^(?:https?:\/\/|www\.)[^\s<>]+$/i;

/** A web address in a text: where it stands and where it leads. */
export interface WebLink {
  start: number;
  end: number;
  href: string;
  /** A Markdown link's words; the rest of it (brackets, address) is markers. */
  label?: { start: number; end: number };
}

const hrefOf = (url: string) => (/^www\./i.test(url) ? `https://${url}` : url);

/** The web addresses of a text, Markdown links among them, in order. */
export function webLinks(text: string): WebLink[] {
  if (!text.includes('://') && !/www\./i.test(text)) return [];
  const out: WebLink[] = [];
  if (text.includes('](')) {
    for (const m of text.matchAll(MD_LINK_RE)) {
      const start = m.index;
      out.push({ start, end: start + m[0].length, href: hrefOf(m[2]), label: { start: start + 1, end: start + 1 + m[1].length } });
    }
  }
  const links = out.length;
  for (const m of text.matchAll(URL_RE)) {
    // Inside a Markdown link: its address, or an address as its words.
    if (out.some((l, i) => i < links && m.index >= l.start && m.index < l.end)) continue;
    let url = m[0];
    for (;;) {
      if (TRAILING.test(url)) url = url.slice(0, -1);
      else if (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
      else break;
    }
    if (/^(?:https?:\/\/|www\.)$/i.test(url)) continue;
    out.push({ start: m.index, end: m.index + url.length, href: hrefOf(url) });
  }
  return links ? out.sort((a, b) => a.start - b.start) : out;
}

/**
 * A web address pasted over selected words: they become its link,
 * `[words](address)`; spaces at the selection's edges stay outside. The
 * replacement of [start, end), or null when it is not that (no words, more
 * than an address, words a link cannot hold).
 */
export function linkOver(text: string, start: number, end: number, pasted: string): string | null {
  const url = pasted.trim();
  const words = text.slice(start, end);
  const core = words.trim();
  if (!core || !ADDRESS_RE.test(url) || /[[\]\n]/.test(core)) return null;
  const lead = words.slice(0, words.indexOf(core));
  const trail = words.slice(lead.length + core.length);
  return `${lead}[${core}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})${trail}`;
}

/** `[[title]]`: no brackets or line breaks inside, and not blank. */
export const LINK_RE = /\[\[(?=[^[\]\n]*[^[\]\s])([^[\]\n]+)\]\]/g;

// A marker opens before a non-space and closes after one, at word edges:
// "2*3*4", snake_case and a lone "*" stay as they are. Bold may hold an
// italic run right at its edges: `***both***`, `**a *b***`.
const BOLD_RE = /(?<![\p{L}\p{N}*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\p{L}\p{N}*])/gu;
const ITALIC_RE = /(?<![\p{L}\p{N}*_])([*_])(?!\1)(?=\S)(.+?)(?<=\S)(?<!\1\1)\1(?![\p{L}\p{N}*_])/gu;

/** Formatting flags of each character (BOLD, ITALIC, MARKER, LINK, URL); null when the text has none. */
export function formatFlags(text: string): Uint8Array | null {
  const links = text.includes('[[');
  const web = webLinks(text);
  if (!links && !web.length && !text.includes('*') && !text.includes('_')) return null;
  let flags: Uint8Array | null = null;
  // A link's brackets are markers too, flagged LINK as well: plainText drops
  // them, a link's title (links.ts) keeps them.
  if (links) {
    for (const m of text.matchAll(LINK_RE)) {
      flags ??= new Uint8Array(text.length);
      const start = m.index;
      const end = start + m[0].length;
      for (let i = start; i < end; i++) flags[i] = i < start + 2 || i >= end - 2 ? MARKER | LINK : LINK;
    }
  }
  // A web address outside a link: its `_` and `*` are not markers. Formatting
  // is looked for with it written over in letters (same length), so a bold
  // run may still hold a whole address. A Markdown link's brackets and
  // address are markers, written over in dashes: its words may be bold or
  // italic, and a bold run may hold the whole link.
  let plain = text;
  for (const w of web) {
    if (flags && flags[w.start] & LINK) continue;
    flags ??= new Uint8Array(text.length);
    const label = w.label;
    if (!label) {
      for (let i = w.start; i < w.end; i++) flags[i] |= URL;
      plain = plain.slice(0, w.start) + 'x'.repeat(w.end - w.start) + plain.slice(w.end);
      continue;
    }
    for (let i = w.start; i < w.end; i++) flags[i] |= i < label.start || i >= label.end ? URL | MARKER : URL;
    plain = plain.slice(0, w.start) + '-' + plain.slice(label.start, label.end) + '-'.repeat(w.end - label.end) + plain.slice(w.end);
  }
  const mark = (source: string, re: RegExp, style: number, marker: number) => {
    for (const m of source.matchAll(re)) {
      flags ??= new Uint8Array(text.length);
      const start = m.index;
      const end = start + m[0].length;
      for (let i = start; i < end; i++) flags[i] |= i < start + marker || i >= end - marker ? MARKER : style;
    }
  };
  mark(plain, BOLD_RE, BOLD, 2);
  // Italic is looked for with bold's (and links') markers blanked out (same length, so
  // offsets hold): they neither open nor glue to an italic run. A web link's
  // stay dashes: an italic run may hold the whole link.
  let source = plain;
  const bold = flags as Uint8Array | null;
  if (bold) {
    source = '';
    for (let i = 0; i < plain.length; i++) source += (bold[i] & (MARKER | URL)) === MARKER ? ' ' : plain[i];
  }
  mark(source, ITALIC_RE, ITALIC, 1);
  return flags;
}

/** How many of bold, italic, a link and a web link a character is inside. */
function depth(flags: Uint8Array, i: number): number {
  if (i < 0 || i >= flags.length) return 0;
  return (flags[i] & BOLD ? 1 : 0) + (flags[i] & ITALIC ? 1 : 0) + (flags[i] & LINK ? 1 : 0) + (flags[i] & URL ? 1 : 0);
}

/**
 * Where a click in the static view puts the caret. Markers are hidden there,
 * so the two sides of a run of them look the same, and the browser picks the
 * edge of the visible text: inside the formatting (`**bold|**`). The caret
 * goes to the side outside it (`**bold**|`, `|**bold**`): Enter then leaves
 * the run whole. Between two runs (`**a***b*`) it stays where it was.
 */
export function caretOutside(text: string, offset: number): number {
  const flags = formatFlags(text);
  if (!flags) return offset;
  let start = offset;
  while (start > 0 && flags[start - 1] & MARKER) start--;
  let end = offset;
  while (end < text.length && flags[end] & MARKER) end++;
  if (start === end) return offset;
  const left = depth(flags, start - 1);
  const right = depth(flags, end);
  return left < right ? start : right < left ? end : offset;
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
