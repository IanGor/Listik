import type { Doc } from './doc';
import type { LinkToken } from './links';
import type { NodeId } from './types';

/**
 * Mirrors, as in Workflowy: `((` typed in a bullet closes to `(())` and
 * offers bullets by title (the same completion as `[[links]]`); the one
 * taken does not become text but turns the bullet into a *mirror* of it:
 * `OutlineNode.mirrorOf`. A mirror shows, and edits, the text, note and
 * task state of the bullet it mirrors (`Doc.content`), so the same bullet
 * can be worked on in several places and every place changes at once.
 * Its own children it has none: zooming into a mirror leads to the
 * original, where the children are. A mirror of a mirror points at the
 * original (`Doc.origin`).
 *
 * `(( ))` left as text (no suggestion taken) stays text.
 */

const STOP = /[()\n]/;

/** The `((…` the caret is in, through its `))` if closed: the token completion replaces. */
export function mirrorBefore(text: string, caret: number): LinkToken | null {
  let i = caret;
  while (i > 0 && !STOP.test(text[i - 1])) i--;
  if (i < 2 || text[i - 1] !== '(' || text[i - 2] !== '(') return null;
  let end = caret;
  while (end < text.length && !STOP.test(text[end])) end++;
  return { start: i - 2, end: text.startsWith('))', end) ? end + 2 : caret, query: text.slice(i, caret) };
}

/** `(` was just typed at `caret - 1`: does it open a mirror, to be closed with `))` right away? */
export function opensMirror(text: string, caret: number): boolean {
  return text.startsWith('((', caret - 2) && text[caret - 3] !== '(' && !text.startsWith('))', caret);
}

/** `)` typed at `caret` steps over the closing bracket already there, in a mirror being typed. */
export function closesMirror(text: string, caret: number): boolean {
  if (text[caret] !== ')') return false;
  const at = text.startsWith('))', caret) ? caret : text[caret - 1] === ')' ? caret - 1 : -1;
  return at >= 0 && text.startsWith('))', at) && mirrorBefore(text, at) !== null;
}

/** Is the row a mirror (of a bullet that still exists)? */
export const isMirror = (doc: Doc, id: NodeId): boolean => {
  const n = doc.nodes.get(id);
  return !!n?.mirrorOf && doc.nodes.has(n.mirrorOf);
};
