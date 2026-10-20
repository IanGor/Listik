import type { Doc } from './doc';
import { plainText } from './format';
import { findTargets } from './links';
import type { TextIndex } from './search';
import type { NodeId } from './types';

/**
 * Places: bullets to go to (or move bullets into) by their title, the
 * places line's list (view/GoTo.tsx). Found as links are
 * (`findTargets`: titles that start with what is typed first, then a word
 * in them, then the rest; one per title, where a link with it would lead),
 * shown with the path to them.
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
  const found = findTargets(doc, index, query, '', skip ? limit + 8 : limit);
  return found.filter((t) => !skip?.(t.id)).slice(0, limit).map((t) => placeOf(doc, t.id));
}
