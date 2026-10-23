import type { Doc } from './doc';
import { LINK, LINK_RE, MARKER, formatFlags } from './format';
import { normalize, type TextIndex } from './search';
import { searchable } from './tags';
import type { NodeId } from './types';

/**
 * Links between bullets, wiki style: `[[title]]` in a bullet's text or note
 * leads to the bullet whose text reads `title` (formatting markers aside,
 * any case, ё = е). A link holds the title, not an id: it reads the same
 * while editing, in exports and in another app. Several bullets with the
 * same title: the first in document order wins.
 * A `#secret` bullet and all inside it are not linked to: links see only
 * what the text index does (tags.ts `searchable`).
 *
 * Typing `[[` closes the pair; completion offers bullets by title
 * (view/Suggest.tsx); a click on a link zooms into its bullet
 * (`Outliner.followLink`).
 */

/** A bullet's text as a link names it: bold and italic markers dropped, a link's brackets kept, trimmed. */
export function titleOf(text: string): string {
  const flags = formatFlags(text);
  if (!flags) return text.trim();
  let out = '';
  for (let i = 0; i < text.length; i++) if ((flags[i] & (MARKER | LINK)) !== MARKER) out += text[i];
  return out.trim();
}

/** Whether a title can stand inside `[[…]]`. */
const linkable = (title: string) => title !== '' && !/[[\]\n]/.test(title);

/** The bullet's own text out of TextIndex's normalized text + note. */
const firstLine = (t: string) => {
  const nl = t.indexOf('\n');
  return nl < 0 ? t : t.slice(0, nl);
};

/** -1 if `a` comes before `b` in the outline (pre-order), 1 if after. */
export function compareOrder(doc: Doc, a: NodeId, b: NodeId): number {
  const path = (id: NodeId) => {
    const out: NodeId[] = [];
    for (let n = doc.get(id); n.parent !== null; n = doc.get(n.parent)) out.push(n.id);
    return out.reverse();
  };
  const pa = path(a);
  const pb = path(b);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  if (i === pa.length) return i === pb.length ? 0 : -1;
  if (i === pb.length) return 1;
  return doc.index(pa[i]) < doc.index(pb[i]) ? -1 : 1;
}

/** The bullet a link leads to: the first one titled so; null if there is none. */
export function resolveLink(doc: Doc, index: TextIndex, title: string): NodeId | null {
  const key = normalize(title.trim());
  if (!key) return null;
  let found: NodeId | null = null;
  for (const [id, t] of index.entries()) {
    const line = firstLine(t);
    if (line.length < key.length || titleOf(line) !== key) continue;
    if (found === null || compareOrder(doc, id, found) < 0) found = id;
  }
  return found;
}

/**
 * Backlinks: bullets whose text or note holds a `[[link]]` that leads to
 * `target`, in document order. A link leads to the first bullet so titled
 * (`resolveLink`), so a bullet that shares its title with an earlier one
 * has none. One pass over the text index finds both the candidates (the
 * normalized `[[title]]` in their text) and the first bullet titled so.
 */
export function backlinks(doc: Doc, index: TextIndex, target: NodeId): NodeId[] {
  const key = normalize(titleOf(doc.get(target).text));
  if (!linkable(key)) return [];
  const needle = `[[${key}]]`;
  const found: NodeId[] = [];
  let first: NodeId | null = null;
  for (const [id, t] of index.entries()) {
    if (t.includes(needle) && id !== target) found.push(id);
    const line = firstLine(t);
    if (line.length >= key.length && titleOf(line) === key && (first === null || compareOrder(doc, id, first) < 0)) first = id;
  }
  if (first !== target) return [];
  return found.sort((a, b) => compareOrder(doc, a, b));
}

/** The title of a normalized first line: the line itself unless formatting markers may stand in it. */
const lineTitle = (line: string) => (line.includes('*') || line.includes('_') ? titleOf(line) : line.trim());

/**
 * A bullet's title changed: `before` was its text. Links lead by title, so
 * the bullets whose `[[links]]` led to it under the old one (text or note)
 * are to be rewritten to `title`, the new one. Null when there is nothing
 * to rewrite: the title is the same (to `normalize`), one of the two cannot
 * stand in a link, no link names the old title, or such links led to an
 * earlier bullet with that title, not to this one. `taken`: an earlier
 * bullet already has the new title, so rewritten links would lead there.
 * A pass over the text index for the links; only if there are any, a
 * second one for the titles.
 */
export function retitledLinks(doc: Doc, index: TextIndex, id: NodeId, before: string): { ids: NodeId[]; title: string; taken: boolean } | null {
  const from = normalize(titleOf(before));
  const title = titleOf(doc.get(id).text);
  const to = normalize(title);
  if (from === to || !linkable(from) || !linkable(to)) return null;
  const needle = `[[${from}]]`;
  const shortest = Math.min(from.length, to.length);
  const ids: NodeId[] = [];
  for (const [other, t] of index.entries()) if (t.includes(needle)) ids.push(other);
  if (!ids.length) return null;
  // Links name the old title: did they lead here, and will they under the new one?
  let taken = false;
  for (const [other, t] of index.entries()) {
    if (other === id) continue;
    const line = firstLine(t);
    if (line.length < shortest) continue;
    const key = lineTitle(line);
    if (key !== from && key !== to) continue;
    if (compareOrder(doc, other, id) > 0) continue;
    if (key === from) return null;
    taken = true;
  }
  return { ids, title, taken };
}

/** `text` with every `[[link]]` that names `from` (normalized) naming `title` instead. */
export function relinkText(text: string, from: string, title: string): string {
  if (!text.includes('[[')) return text;
  return text.replace(LINK_RE, (link, name: string) => (normalize(name.trim()) === from ? `[[${title}]]` : link));
}

/** Where in its text a bullet links to `target`'s title: the offset right after the link, or -1 (the link is in the note). */
export function linkEnd(text: string, targetText: string): number {
  const needle = `[[${normalize(titleOf(targetText))}]]`;
  const at = normalize(text).indexOf(needle);
  return at < 0 ? -1 : at + needle.length;
}

/** A link being typed: from its `[[` to its `]]` (or the caret, if not closed yet), and what is typed so far. */
export interface LinkToken {
  start: number;
  end: number;
  query: string;
}

const STOP = /[[\]\n]/;

/**
 * The link the caret is in: `[[`, then anything but brackets up to the
 * caret. The token runs on through its `]]`, if the pair is closed, so a
 * suggestion taken replaces the whole link.
 */
export function linkBefore(text: string, caret: number): LinkToken | null {
  let i = caret;
  while (i > 0 && !STOP.test(text[i - 1])) i--;
  if (i < 2 || text[i - 1] !== '[' || text[i - 2] !== '[') return null;
  let end = caret;
  while (end < text.length && !STOP.test(text[end])) end++;
  return { start: i - 2, end: text.startsWith(']]', end) ? end + 2 : caret, query: text.slice(i, caret) };
}

/** `[` was just typed at `caret - 1`: does it open a link, to be closed with `]]` right away? */
export function opensLink(text: string, caret: number): boolean {
  return text.startsWith('[[', caret - 2) && text[caret - 3] !== '[' && !text.startsWith(']]', caret);
}

/** `]` typed at `caret` steps over the closing bracket already there, in a link being typed. */
export function closesLink(text: string, caret: number): boolean {
  if (text[caret] !== ']') return false;
  const at = text.startsWith(']]', caret) ? caret : text[caret - 1] === ']' ? caret - 1 : -1;
  return at >= 0 && text.startsWith(']]', at) && linkBefore(text, at) !== null;
}

/** A bullet a link may lead to, as completion offers it. */
export interface Target {
  id: NodeId;
  /** What goes inside `[[…]]`. */
  title: string;
  /** The parent's title, to tell bullets apart; '' at the top level. */
  where: string;
}

interface Candidate {
  id: NodeId;
  /** 0: the title starts with the query, 1: a word in it does, 2: it merely contains it. */
  rank: number;
  /** The title's length; 0 when nothing is typed, so only recency counts. */
  length: number;
  /** Read only on a tie: a lookup in a large map costs more than all the rest. */
  updated: number | null;
  /** The normalized title, once worked out: one suggestion per title. */
  key: string;
}

const WORD_START = /[^\p{L}\p{N}]/u;
/**
 * A space or a formatting marker (`*`, `_`): where the raw text starts or
 * ends, or right before the match, rank and length need the title itself.
 */
const shifts = (text: string, i: number) => {
  const c = text.charCodeAt(i);
  return c <= 32 || c === 42 || c === 95 || c === 160;
};

/**
 * Bullets to link to for what is typed after `[[`, at most `limit`, one per
 * title: titles that start with the query first, then those where a word
 * does, then those that merely contain it; shorter titles first, then the
 * ones edited last. Nothing typed yet: the bullets edited last. `self`
 * (the bullet being edited) is left out.
 *
 * One pass over the text index that keeps only the best few: a bullet that
 * can't beat the worst of them costs an `indexOf` and a comparison or two.
 * So the query is found in the raw text, where formatting markers may stand
 * between its words.
 *
 * `every`: each bullet on its own, a title many share as many times (a
 * place to go to, model/places.ts: every day's "todo"), not where a link
 * with it would lead.
 */
export function findTargets(doc: Doc, index: TextIndex, query: string, self: NodeId, limit: number, every = false): Target[] {
  const q = normalize(query.trim());
  const best: Candidate[] = [];
  const updated = (c: Candidate) => (c.updated ??= doc.get(c.id).updated);
  const better = (a: Candidate, b: Candidate) =>
    a.rank !== b.rank ? a.rank < b.rank : a.length !== b.length ? a.length < b.length : updated(a) > updated(b);
  /** Keeps `c` if it is among the best, and only the better of two with one title. */
  const offer = (c: Candidate, text: () => string) => {
    if (best.length === limit && !better(c, best[limit - 1])) return;
    c.key = titleOf(text());
    if (!linkable(c.key)) return;
    const same = every ? -1 : best.findIndex((b) => b.key === c.key);
    if (same >= 0) {
      if (!better(c, best[same])) return;
      best.splice(same, 1);
    }
    let i = best.length;
    while (i > 0 && better(c, best[i - 1])) i--;
    best.splice(i, 0, c);
    if (best.length > limit) best.pop();
  };

  // Bullets that may share a title with one of those kept, for the pass below.
  const ids: NodeId[] = [];
  const texts: string[] = [];
  if (q) {
    for (const [id, t] of index.entries()) {
      const at = t.indexOf(q);
      if (at < 0) continue;
      const nl = t.indexOf('\n');
      const end = nl < 0 ? t.length : nl;
      if (at + q.length > end) continue;
      ids.push(id);
      texts.push(nl < 0 ? t : t.slice(0, end));
      if (id === self) continue;
      let pos = at;
      let length = end;
      if (shifts(t, 0) || (at > 0 && shifts(t, at - 1))) {
        const key = titleOf(t.slice(0, end));
        pos = key.indexOf(q);
        length = key.length;
        if (pos < 0) continue;
      }
      // Cheap test first: with the best few all starting with the query, nothing else gets in.
      if (pos > 0 && best.length === limit && best[limit - 1].rank === 0) continue;
      const rank = pos === 0 ? 0 : WORD_START.test(t[at - 1]) ? 1 : 2;
      offer({ id, rank, length, updated: null, key: '' }, () => t.slice(0, end));
    }
  } else {
    // By recency alone, straight from the doc's nodes: the trash, `#secret` and the root are checked only for those kept.
    for (const n of doc.nodes.values()) {
      if (best.length === limit && n.updated <= best[limit - 1].updated!) continue;
      if (n.id === self || n.id === doc.root || !n.text || !searchable(doc, n.id)) continue;
      offer({ id: n.id, rank: 0, length: 0, updated: n.updated, key: '' }, () => normalize(n.text));
    }
  }
  if (!best.length) return [];
  if (every) return best.map((c) => target(doc, c.id));

  // A link leads to the first bullet with its title: suggest that one, so
  // the hint shows where the link will really go. Looked for among texts as
  // long as a title kept, or with formatting at an edge.
  const chosen = new Map(best.map((c) => [c.key, c.id]));
  const lengths = new Set(best.map((c) => c.key.length));
  const same = (id: NodeId, line: string) => {
    if (!lengths.has(line.length) && !shifts(line, 0) && !shifts(line, line.length - 1)) return;
    const key = titleOf(line);
    const cur = chosen.get(key);
    if (cur !== undefined && cur !== id && compareOrder(doc, id, cur) < 0) chosen.set(key, id);
  };
  if (q) for (let i = 0; i < ids.length; i++) same(ids[i], texts[i]);
  else {
    for (const n of doc.nodes.values()) {
      if (n.text && (lengths.has(n.text.length) || shifts(n.text, 0) || shifts(n.text, n.text.length - 1))) {
        if (chosen.has(normalize(titleOf(n.text))) && searchable(doc, n.id)) same(n.id, normalize(n.text));
      }
    }
  }
  return best.map((c) => target(doc, chosen.get(c.key)!));
}

function target(doc: Doc, id: NodeId): Target {
  const n = doc.get(id);
  const parent = n.parent !== null && n.parent !== doc.root ? doc.get(n.parent) : null;
  return { id, title: titleOf(n.text), where: parent ? titleOf(parent.text) : '' };
}
