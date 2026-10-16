import { newId, type Doc } from './doc';
import type { VisibleRows } from './rows';
import type { Focus, NodeId } from './types';

/**
 * User-level editing actions. Each applies ops to the doc (the caller wraps
 * it in `doc.transact`) and returns where the caret should go, or nothing if
 * focus stays put. A command that does not apply makes no ops.
 */
export interface Ctx {
  doc: Doc;
  rows: VisibleRows;
}

function insertNew(doc: Doc, parent: NodeId, index: number, text: string): NodeId {
  const id = newId();
  const now = Date.now();
  doc.apply({
    t: 'insert',
    parent,
    node: { id, order: doc.orderAt(parent, index), text, collapsed: false, created: now, updated: now, children: [] },
  });
  return id;
}

function moveTo(doc: Doc, id: NodeId, parent: NodeId, index: number): void {
  const n = doc.get(id);
  doc.apply({
    t: 'move',
    id,
    from: { parent: n.parent!, order: n.order },
    to: { parent, order: doc.orderAt(parent, index) },
  });
}

function remove(doc: Doc, id: NodeId): void {
  doc.apply({ t: 'remove', parent: doc.get(id).parent!, node: doc.snapshot(id) });
}

function expand(doc: Doc, id: NodeId): void {
  const n = doc.get(id);
  if (n.collapsed) doc.apply({ t: 'setCollapsed', id, from: true, to: false });
}

export function setText({ doc }: Ctx, id: NodeId, text: string): void {
  const n = doc.get(id);
  if (n.text !== text) doc.apply({ t: 'setText', id, from: n.text, to: text, at: Date.now() });
}

export function setCollapsed({ doc }: Ctx, id: NodeId, value: boolean): void {
  const n = doc.get(id);
  if (n.children.length > 0 && n.collapsed !== value) {
    doc.apply({ t: 'setCollapsed', id, from: n.collapsed, to: value });
  }
}

/** Enter: split the bullet at the caret. */
export function split({ doc, rows }: Ctx, id: NodeId, caret: number): Focus {
  const n = doc.get(id);
  const parent = n.parent!;
  if (caret === 0 && n.text.length > 0) {
    insertNew(doc, parent, doc.index(id), '');
    return { id, caret: 0 };
  }
  const after = n.text.slice(caret);
  setText({ doc, rows }, id, n.text.slice(0, caret));
  if (n.children.length > 0 && rows.expanded(n)) {
    return { id: insertNew(doc, id, 0, after), caret: 0 };
  }
  return { id: insertNew(doc, parent, doc.index(id) + 1, after), caret: 0 };
}

/**
 * Paste: replace [start, end) of the bullet with `lines`. Extra lines become
 * new bullets below it; the text after the selection moves to the last one.
 */
export function insertText(ctx: Ctx, id: NodeId, start: number, end: number, lines: string[]): Focus {
  const { doc } = ctx;
  const n = doc.get(id);
  const before = n.text.slice(0, start);
  const after = n.text.slice(end);
  const last = lines.length - 1;
  if (last === 0) {
    setText(ctx, id, before + lines[0] + after);
    return { id, caret: start + lines[0].length };
  }
  setText(ctx, id, before + lines[0]);
  const parent = n.parent!;
  let index = doc.index(id) + 1;
  let cur = id;
  for (let k = 1; k <= last; k++) cur = insertNew(doc, parent, index++, k === last ? lines[k] + after : lines[k]);
  return { id: cur, caret: lines[last].length };
}

/**
 * Backspace at the start of a bullet: remove it if empty, otherwise append
 * its text to the previous visible row. Bullets with children are left alone
 * so nothing gets lost.
 */
export function mergeUp({ doc, rows }: Ctx, id: NodeId): Focus | void {
  const n = doc.get(id);
  if (n.children.length > 0) return;
  const i = rows.indexOf(id);
  if (i <= 0) return;
  const prevId = rows.ids[i - 1];
  const prev = doc.get(prevId);
  const caret = prev.text.length;
  if (n.text) setText({ doc, rows }, prevId, prev.text + n.text);
  remove(doc, id);
  return { id: prevId, caret };
}

/** Delete a bullet with its subtree. The outline never becomes empty. */
export function deleteNode({ doc, rows }: Ctx, id: NodeId): Focus | void {
  const i = rows.indexOf(id);
  const prev = i > 0 ? rows.ids[i - 1] : null;
  const end = i >= 0 ? rows.subtreeEnd(i) : -1;
  const next = i >= 0 && end < rows.length ? rows.ids[end] : null;
  remove(doc, id);
  if (doc.get(doc.root).children.length === 0) return { id: insertNew(doc, doc.root, 0, ''), caret: 0 };
  if (prev) return { id: prev, caret: doc.get(prev).text.length };
  if (next) return { id: next, caret: 0 };
}

/** Tab: become the last child of the previous sibling. */
export function indent({ doc }: Ctx, id: NodeId): void {
  const i = doc.index(id);
  if (i === 0) return;
  const prevId = doc.get(doc.get(id).parent!).children[i - 1];
  expand(doc, prevId);
  moveTo(doc, id, prevId, doc.get(prevId).children.length);
}

/** Shift+Tab: become the next sibling of the parent. Later siblings stay where they are. */
export function outdent({ doc }: Ctx, id: NodeId): void {
  const parent = doc.get(doc.get(id).parent!);
  if (parent.id === doc.root) return;
  moveTo(doc, id, parent.parent!, doc.index(parent.id) + 1);
}

/** Swap with the previous sibling; the first child moves to the end of the parent's previous sibling. */
export function moveUp({ doc }: Ctx, id: NodeId): void {
  const parent = doc.get(doc.get(id).parent!);
  const i = parent.children.indexOf(id);
  if (i > 0) return moveTo(doc, id, parent.id, i - 1);
  if (parent.id === doc.root) return;
  const pi = doc.index(parent.id);
  if (pi === 0) return;
  const target = doc.get(parent.parent!).children[pi - 1];
  expand(doc, target);
  moveTo(doc, id, target, doc.get(target).children.length);
}

/** Swap with the next sibling; the last child moves to the start of the parent's next sibling. */
export function moveDown({ doc }: Ctx, id: NodeId): void {
  const parent = doc.get(doc.get(id).parent!);
  const i = parent.children.indexOf(id);
  if (i < parent.children.length - 1) return moveTo(doc, id, parent.id, i + 2);
  if (parent.id === doc.root) return;
  const uncles = doc.get(parent.parent!).children;
  const pi = uncles.indexOf(parent.id);
  if (pi === uncles.length - 1) return;
  const target = uncles[pi + 1];
  expand(doc, target);
  moveTo(doc, id, target, 0);
}
