import type { Doc } from './doc';
import type { LinkToken } from './links';
import type { NodeId } from './types';

/**
 * Mirrors, as in Workflowy: `((` typed in a bullet closes to `(())` and
 * offers bullets by title (the same completion as `[[links]]`); the one
 * taken does not become text but makes the bullet another *copy* of it.
 * Copies are alike: each shows a diamond, shows and edits the same text,
 * note, task state and children, and folds on its own (model/rows.ts
 * `folds`). Taking one out leaves the rest; of two, the one left is a
 * plain bullet again.
 *
 * Underneath, one copy holds it all (`Doc.origin`) and the others point at
 * it (`OutlineNode.mirrorOf`, `Doc.content`, `Doc.copies`); when that one
 * goes, it hands everything to another (commands.ts `handOver`). A mirror
 * has no children of its own: zooming into it leads to where they are.
 *
 * `((title))` typed out to its last `)` mirrors the bullet so titled, or a
 * new one made last in the structure's Inbox (`Outliner.mirrorTitled`); with
 * neither, it stays text.
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
