import { linkBefore } from './links';
import type { Sigil } from './tags';

/**
 * Completion of `/commands`, `#tags`, `@tags` and `[[links]]` while typing
 * (view/Suggest.tsx): what is being typed before the caret, and what it may
 * become.
 */

/**
 * A `/command`, `#tag`, `@tag` or `[[link` being typed: the sigil, what
 * follows it up to the caret, and the word's span (a link's, through its `]]`).
 */
export interface Token {
  kind: '/' | Sigil | '[[';
  /** Typed after the sigil, up to the caret. */
  query: string;
  /** Where the sigil is. */
  start: number;
  /** End of the word the caret is in: picking a suggestion replaces start..end. */
  end: number;
}

const WORD = /[\p{L}\p{N}_-]/u;

/**
 * The token right before `caret`: the link the caret is in (model/links.ts),
 * or else a sigil, then word characters up to the caret. The sigil starts
 * the text or follows whitespace (a tag also "(", as in tags.ts), so "a/b",
 * URLs, "a#b" and "a@mail.ru" are not tokens.
 */
export function tokenBefore(text: string, caret: number): Token | null {
  const link = linkBefore(text, caret);
  if (link) return { kind: '[[', ...link };
  let i = caret;
  while (i > 0 && WORD.test(text[i - 1])) i--;
  const start = i - 1;
  if (start < 0) return null;
  const kind = text[start];
  if (kind !== '/' && kind !== '#' && kind !== '@') return null;
  if (start > 0 && !(kind === '/' ? /\s/ : /[\s(]/).test(text[start - 1])) return null;
  let end = caret;
  while (end < text.length && WORD.test(text[end])) end++;
  return { kind, query: text.slice(i, caret), start, end };
}

export interface Command {
  name: string;
  hint: string;
}

/** What `/` offers; the action of each lives in view/Suggest.tsx. */
export const COMMANDS: readonly Command[] = [{ name: 'time', hint: 'текущее время, ЧЧ:ММ' }];

/** Commands whose name starts with the query. */
export function matchCommands(query: string): Command[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

/**
 * Tags for a query, at most `limit`: those that start with it, then those
 * that contain it; more frequent first, then alphabetically. Tags counted 0
 * are left out (the one being typed, before it exists anywhere else).
 */
export function matchTags(tags: Iterable<[tag: string, count: number]>, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const prefix: [string, number][] = [];
  const inside: [string, number][] = [];
  for (const entry of tags) {
    const [tag, count] = entry;
    if (count <= 0) continue;
    if (tag.startsWith(q)) prefix.push(entry);
    else if (q && tag.includes(q)) inside.push(entry);
  }
  const order = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru');
  return [...prefix.sort(order), ...inside.sort(order)].slice(0, limit).map(([tag]) => tag);
}

/** Rows of suggestions that fit: about a third of the window, 3 to 8. */
export function suggestLimit(windowHeight: number, rowHeight: number): number {
  return Math.max(3, Math.min(8, Math.floor((windowHeight * 0.3) / rowHeight)));
}
