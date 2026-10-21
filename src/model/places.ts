import type { Doc } from './doc';
import { plainText } from './format';
import { findTargets } from './links';
import type { TextIndex } from './search';
import type { NodeId } from './types';

/**
 * Places: bullets to go to (or move bullets into) by their title, the
 * places line's list (view/GoTo.tsx). Found as links are
 * (`findTargets`: titles that start with what is typed first, then a word
 * in them, then the rest; shorter, then edited last, first), but every
 * bullet on its own: many share a title (each day's "todo"), and the path
 * shown tells them apart.
 */
export interface Place {
  id: NodeId;
  title: string;
  /** Titles of the bullets above it, from the top level down; empty at the top level. */
  path: string[];
}

/** The titles above a bullet, from the top level down, as crumbs show them. */
export function pathOf(doc: Doc, id: NodeId): string[] {
  const out: string[] = [];
  for (let p = doc.get(id).parent; p !== null && p !== doc.root; p = doc.get(p).parent) out.push(plainText(doc.get(p).text).trim());
  return out.reverse();
}

export function placeOf(doc: Doc, id: NodeId): Place {
  return { id, title: plainText(doc.content(id).text).trim(), path: pathOf(doc, id) };
}

/**
 * Places for what is typed, at most `limit`, best first, without those
 * `skip` rules out (bullets being moved and what is inside them).
 */
export function findPlaces(doc: Doc, index: TextIndex, query: string, limit: number, skip?: (id: NodeId) => boolean): Place[] {
  // A few more than asked: some may be skipped.
  const found = findTargets(doc, index, query, '', skip ? limit + 8 : limit, true);
  return found.filter((t) => !skip?.(t.id)).slice(0, limit).map((t) => placeOf(doc, t.id));
}

/** Words for today's day in "Перейти к…": the logo's way there. */
const TODAY = ['today', 'сегодня'];

/**
 * Whether what is typed names today: the start of "today" or "сегодня",
 * three letters on (fewer would put it before places of every "т…").
 */
export function meansToday(query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length >= 3 && TODAY.some((w) => w.startsWith(q));
}
