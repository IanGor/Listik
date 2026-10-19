import { generateKeyBetween } from 'fractional-indexing';
import { clock } from './clock';
import { TRASH, newId, trashKey, type Doc } from './doc';
import { countTrees, type Tree } from './outline-text';
import type { VisibleRows } from './rows';
import type { Focus, NodeId, NodeSnapshot } from './types';

/**
 * User-level editing actions. Each applies ops to the doc (the caller wraps
 * it in `doc.transact`) and returns where the caret should go, or nothing if
 * focus stays put. A command that does not apply makes no ops.
 */
export interface Ctx {
  doc: Doc;
  rows: VisibleRows;
}

function insertNew(doc: Doc, parent: NodeId, index: number, text: string, mirrorOf?: NodeId): NodeId {
  const id = newId();
  const now = clock.now();
  doc.apply({
    t: 'insert',
    parent,
    node: {
      id, order: doc.orderAt(parent, index), text, note: '', collapsed: false, todo: false, done: false,
      created: now, updated: now, children: [], ...(mirrorOf ? { mirrorOf } : {}),
    },
  });
  return id;
}

/** A mirror never holds children of its own: they live with the original. */
const holdsChildren = (doc: Doc, id: NodeId) => !doc.get(id).mirrorOf;

function moveTo(doc: Doc, id: NodeId, parent: NodeId, index: number): void {
  const n = doc.get(id);
  doc.apply({
    t: 'move',
    id,
    from: { parent: n.parent!, order: n.order },
    to: { parent, order: doc.orderAt(parent, index) },
  });
}

/** Deleting a bullet moves it into the trash, keyed by the time (see TRASH in doc.ts). */
function remove(doc: Doc, id: NodeId): void {
  const n = doc.get(id);
  doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: TRASH, order: trashKey(clock.now()) } });
}

function expand(doc: Doc, id: NodeId): void {
  const n = doc.get(id);
  if (n.collapsed) doc.apply({ t: 'setCollapsed', id, from: true, to: false });
}

// Text, note and task state belong to the bullet a row shows (`Doc.content`):
// through a mirror they change the original, and so every mirror of it.

export function setText({ doc }: Ctx, id: NodeId, text: string): void {
  const n = doc.content(id);
  if (n.text !== text) doc.apply({ t: 'setText', id: n.id, from: n.text, to: text, at: clock.now() });
}

export function setNote({ doc }: Ctx, id: NodeId, note: string): void {
  const n = doc.content(id);
  if (n.note !== note) doc.apply({ t: 'setNote', id: n.id, from: n.note, to: note, at: clock.now() });
}

/**
 * `((title))` completed in a bullet: the bullet becomes a mirror of
 * `target` when nothing else is written in it; otherwise the token leaves
 * the text and the mirror goes in as the next sibling. A chain of mirrors
 * is flattened to the original; a bullet never mirrors itself.
 */
export function makeMirror(ctx: Ctx, id: NodeId, target: NodeId, start: number, end: number): Focus | void {
  const { doc } = ctx;
  const n = doc.get(id);
  const origin = doc.origin(target);
  if (origin === id || origin === doc.root || origin === TRASH) return;
  const rest = n.text.slice(0, start) + n.text.slice(end);
  if (!rest.trim() && !n.mirrorOf && !n.note && !n.children.length) {
    setText(ctx, id, '');
    if (n.todo) untask(ctx, [id]);
    doc.apply({ t: 'setMirror', id, from: null, to: origin });
    return { id, caret: doc.content(id).text.length };
  }
  setText(ctx, id, rest);
  const mirror = insertNew(doc, n.parent!, doc.index(id) + 1, '', origin);
  return { id: mirror, caret: doc.content(mirror).text.length };
}

/**
 * Ctrl+L: completes the bullets, or un-completes them if all are done
 * already (for a selection: one press sets them all the same way).
 */
export function toggleDone({ doc }: Ctx, ids: NodeId[]): void {
  const value = !ids.every((id) => doc.content(id).done);
  for (const id of ids) {
    const n = doc.content(id);
    if (n.done !== value) doc.apply({ t: 'setDone', id: n.id, from: !value, to: value });
  }
}

/**
 * Ctrl+L: a plain bullet becomes a task (an empty checkbox); a task is
 * checked or unchecked. For several bullets: any plain ones become tasks
 * first; once all are tasks, they are checked (or all unchecked).
 */
export function cycleTask(ctx: Ctx, ids: NodeId[]): void {
  const { doc } = ctx;
  const plain = ids.map((id) => doc.content(id)).filter((n) => !n.todo);
  if (plain.length) for (const n of plain) doc.apply({ t: 'setTodo', id: n.id, from: false, to: true });
  else toggleDone(ctx, ids);
}

/** Ctrl+Shift+L: tasks become plain bullets again (and so not done). */
export function untask({ doc }: Ctx, ids: NodeId[]): void {
  for (const id of ids) {
    const n = doc.content(id);
    if (n.done) doc.apply({ t: 'setDone', id: n.id, from: true, to: false });
    if (n.todo) doc.apply({ t: 'setTodo', id: n.id, from: true, to: false });
  }
}

export function setCollapsed({ doc }: Ctx, id: NodeId, value: boolean): void {
  const n = doc.get(id);
  if (n.children.length > 0 && n.collapsed !== value) {
    doc.apply({ t: 'setCollapsed', id, from: n.collapsed, to: value });
  }
}

/** Collapses every child of `parent` that has children of its own (the logo: home, all folded). */
export function collapseChildren({ doc, rows }: Ctx, parent: NodeId): void {
  const targets = doc.get(parent).children.filter((id) => {
    const n = doc.get(id);
    return n.children.length > 0 && !n.collapsed;
  });
  if (targets.length > 1) rows.expectMany();
  for (const id of targets) doc.apply({ t: 'setCollapsed', id, from: false, to: true });
}

/** A new empty first child: Enter in the title of a zoomed-in bullet. */
export function prependChild({ doc }: Ctx, parent: NodeId): Focus {
  return { id: insertNew(doc, parent, 0, ''), caret: 0 };
}

/** A new empty last child: the "+" under a zoomed-in bullet's list. */
export function appendChild({ doc }: Ctx, parent: NodeId): Focus {
  return { id: insertNew(doc, parent, doc.get(parent).children.length, ''), caret: 0 };
}

/** Enter: split the bullet at the caret (a mirror's text is the original's; the new bullet is a plain sibling). */
export function split({ doc, rows }: Ctx, id: NodeId, caret: number): Focus {
  const n = doc.get(id);
  const c = doc.content(id);
  const parent = n.parent!;
  if (caret === 0 && c.text.length > 0) {
    insertNew(doc, parent, doc.index(id), '');
    return { id, caret: 0 };
  }
  const after = c.text.slice(caret);
  setText({ doc, rows }, id, c.text.slice(0, caret));
  if (rows.showsChildren(n)) {
    return { id: insertNew(doc, id, 0, after), caret: 0 };
  }
  return { id: insertNew(doc, parent, doc.index(id) + 1, after), caret: 0 };
}

/** Snapshot of a tree as new nodes: fresh ids, sequential order keys. */
function snapshotOf(tree: Tree, order: string, now: number): NodeSnapshot {
  let prev: string | null = null;
  return {
    id: newId(), order, text: tree.text, note: tree.note ?? '', collapsed: false,
    todo: tree.todo ?? tree.done ?? false, done: tree.done ?? false,
    created: now, updated: now,
    children: tree.children.map((c) => snapshotOf(c, (prev = generateKeyBetween(prev, null)), now)),
  };
}

/**
 * Paste: replace [start, end) of the bullet with `trees`. The first tree's
 * text goes in at the caret and its children become the bullet's first
 * children; the other trees become bullets below it, with their subtrees.
 * The text after the selection moves to the end of the last tree.
 */
export function insertTrees(ctx: Ctx, id: NodeId, start: number, end: number, trees: Tree[]): Focus {
  const { doc, rows } = ctx;
  const n = doc.get(id);
  const text = doc.content(id).text;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (!trees.length) {
    setText(ctx, id, before + after);
    return { id, caret: start };
  }
  if (countTrees(trees) > 2) rows.expectMany();
  const now = clock.now();
  // A mirror takes no children: the first tree's go in as bullets below it.
  if (n.mirrorOf && trees[0].children.length) trees = [{ ...trees[0], children: [] }, ...trees[0].children, ...trees.slice(1)];
  const last = trees.length - 1;
  const [first] = trees;
  setText(ctx, id, before + first.text + (last === 0 ? after : ''));
  first.children.forEach((c, k) => doc.apply({ t: 'insert', parent: id, node: snapshotOf(c, doc.orderAt(id, k), now) }));
  let focus: Focus = { id, caret: before.length + first.text.length };
  const parent = n.parent!;
  let index = doc.index(id) + 1;
  for (let k = 1; k <= last; k++) {
    const tree = k === last ? { ...trees[k], text: trees[k].text + after } : trees[k];
    const node = snapshotOf(tree, doc.orderAt(parent, index++), now);
    doc.apply({ t: 'insert', parent, node });
    focus = { id: node.id, caret: trees[k].text.length };
  }
  return focus;
}

/** Paste of plain lines: each extra line becomes a bullet below. */
export function insertText(ctx: Ctx, id: NodeId, start: number, end: number, lines: string[]): Focus {
  return insertTrees(ctx, id, start, end, lines.map((text) => ({ text, children: [] })));
}

/** Import: the trees become the last children of `parent`. Focuses the first one. */
export function appendTrees({ doc, rows }: Ctx, parent: NodeId, trees: Tree[]): Focus | void {
  if (countTrees(trees) > 2) rows.expectMany();
  const now = clock.now();
  let first: NodeId | undefined;
  for (const tree of trees) {
    const node = snapshotOf(tree, doc.orderAt(parent, doc.get(parent).children.length), now);
    doc.apply({ t: 'insert', parent, node });
    first ??= node.id;
  }
  if (first) return { id: first, caret: 0 };
}

/**
 * Backspace at the start of a bullet: remove it if empty, otherwise append
 * its text to the previous visible row. Bullets with children or a note are
 * left alone so nothing gets lost.
 */
export function mergeUp({ doc, rows }: Ctx, id: NodeId): Focus | void {
  const n = doc.get(id);
  const c = doc.content(id);
  if (n.children.length > 0 || c.note) return;
  const i = rows.indexOf(id);
  if (i <= 0) return;
  const prevId = rows.ids[i - 1];
  const prev = doc.content(prevId);
  const caret = prev.text.length;
  // A mirror's text belongs to the original, so a mirror only goes when it reads empty; nor is anything merged into one.
  if (n.mirrorOf && c.text) return;
  if (c.text && doc.get(prevId).mirrorOf) return;
  if (c.text) setText({ doc, rows }, prevId, prev.text + c.text);
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
  if (!holdsChildren(doc, prevId)) return;
  expand(doc, prevId);
  moveTo(doc, id, prevId, doc.get(prevId).children.length);
}

/**
 * Shift+Tab: become the next sibling of the parent. Later siblings stay
 * where they are. Never leaves the zoomed-in bullet.
 */
export function outdent({ doc, rows }: Ctx, id: NodeId): void {
  const parent = doc.get(doc.get(id).parent!);
  if (parent.id === doc.root || parent.id === rows.top) return;
  moveTo(doc, id, parent.parent!, doc.index(parent.id) + 1);
}

/** Swap with the previous sibling; the first child moves to the end of the parent's previous sibling. */
export function moveUp({ doc, rows }: Ctx, id: NodeId): void {
  const parent = doc.get(doc.get(id).parent!);
  const i = parent.children.indexOf(id);
  if (i > 0) return moveTo(doc, id, parent.id, i - 1);
  if (parent.id === doc.root || parent.id === rows.top) return;
  const pi = doc.index(parent.id);
  if (pi === 0) return;
  const target = doc.get(parent.parent!).children[pi - 1];
  if (!holdsChildren(doc, target)) return;
  expand(doc, target);
  moveTo(doc, id, target, doc.get(target).children.length);
}

/** Swap with the next sibling; the last child moves to the start of the parent's next sibling. */
export function moveDown({ doc, rows }: Ctx, id: NodeId): void {
  const parent = doc.get(doc.get(id).parent!);
  const i = parent.children.indexOf(id);
  if (i < parent.children.length - 1) return moveTo(doc, id, parent.id, i + 2);
  if (parent.id === doc.root || parent.id === rows.top) return;
  const uncles = doc.get(parent.parent!).children;
  const pi = uncles.indexOf(parent.id);
  if (pi === uncles.length - 1) return;
  const target = uncles[pi + 1];
  if (!holdsChildren(doc, target)) return;
  expand(doc, target);
  moveTo(doc, id, target, 0);
}

// --- Several bullets at once (a selection) -----------------------------------
// `roots` are the selected bullets that are not inside another selected one,
// in document order; each one moves with its subtree.

/** Can `moveUp` move this bullet (inside the zoom)? */
function canMoveUp({ doc, rows }: Ctx, id: NodeId): boolean {
  const parent = doc.get(id).parent!;
  if (doc.index(id) > 0) return true;
  if (parent === doc.root || parent === rows.top || doc.index(parent) === 0) return false;
  return holdsChildren(doc, doc.get(doc.get(parent).parent!).children[doc.index(parent) - 1]);
}

function canMoveDown({ doc, rows }: Ctx, id: NodeId): boolean {
  const parent = doc.get(doc.get(id).parent!);
  if (doc.index(id) < parent.children.length - 1) return true;
  if (parent.id === doc.root || parent.id === rows.top) return false;
  const uncles = doc.get(parent.parent!).children;
  const pi = doc.index(parent.id);
  return pi < uncles.length - 1 && holdsChildren(doc, uncles[pi + 1]);
}

/** Deletes the bullets with their subtrees; focuses the row above them, or below. */
export function deleteMany(ctx: Ctx, roots: NodeId[]): Focus | void {
  const { doc, rows } = ctx;
  if (!roots.length) return;
  const first = rows.indexOf(roots[0]);
  const lastRow = rows.indexOf(roots[roots.length - 1]);
  const prev = first > 0 ? rows.ids[first - 1] : null;
  const end = lastRow >= 0 ? rows.subtreeEnd(lastRow) : -1;
  const next = end >= 0 && end < rows.length ? rows.ids[end] : null;
  if (roots.length > 1) rows.expectMany();
  for (const id of roots) remove(doc, id);
  if (doc.get(doc.root).children.length === 0) return { id: insertNew(doc, doc.root, 0, ''), caret: 0 };
  if (prev) return { id: prev, caret: doc.get(prev).text.length };
  if (next) return { id: next, caret: 0 };
}

/**
 * Tab on a block: each bullet goes under its previous sibling, so consecutive
 * ones stay together. If the first one cannot be indented, the block stays:
 * indenting only its tail would tear it apart.
 */
export function indentMany(ctx: Ctx, roots: NodeId[]): void {
  if (!roots.length || ctx.doc.index(roots[0]) === 0) return;
  for (const id of roots) indent(ctx, id);
}

/** Shift+Tab on a block: from the last bullet up, so their order is kept. */
export function outdentMany(ctx: Ctx, roots: NodeId[]): void {
  for (let k = roots.length - 1; k >= 0; k--) outdent(ctx, roots[k]);
}

/** Moves the block up by one place, whole; nothing if its first bullet cannot move. */
export function moveUpMany(ctx: Ctx, roots: NodeId[]): void {
  if (!roots.length || !canMoveUp(ctx, roots[0])) return;
  for (const id of roots) moveUp(ctx, id);
}

export function moveDownMany(ctx: Ctx, roots: NodeId[]): void {
  if (!roots.length || !canMoveDown(ctx, roots[roots.length - 1])) return;
  for (let k = roots.length - 1; k >= 0; k--) moveDown(ctx, roots[k]);
}

/**
 * Drag and drop: moves the bullets, with their subtrees and in their order,
 * under `parent` right after its child `after` (null: first). Refuses a drop
 * inside one of the moved subtrees. The new order keys lie strictly between
 * two neighbouring keys that exist now, so they can never clash with a key a
 * moving bullet still holds.
 */
export function moveManyTo({ doc, rows }: Ctx, ids: NodeId[], parent: NodeId, after: NodeId | null): void {
  if (!holdsChildren(doc, parent)) return;
  const moving = new Set(ids);
  for (let p: NodeId | null = parent; p !== null; p = doc.get(p).parent) if (moving.has(p)) return;
  const children = doc.get(parent).children;
  let k = after === null ? -1 : children.indexOf(after);
  while (k >= 0 && moving.has(children[k])) k--; // dropped right after a moving bullet: after its predecessor
  const keys = doc.ordersAt(parent, k + 1, ids.length);
  if (ids.length > 2) rows.expectMany();
  if (parent !== doc.root) expand(doc, parent);
  ids.forEach((id, i) => {
    const n = doc.get(id);
    doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent, order: keys[i] } });
  });
}

