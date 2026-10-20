import { generateKeyBetween } from 'fractional-indexing';
import { clock } from './clock';
import { TRASH, newId, trashKey, type Doc } from './doc';
import { countTrees, type Tree } from './outline-text';
import { contextOf, keyIn, nodeOf, type RowKey, type VisibleRows } from './rows';
import type { Focus, NodeId, NodeSnapshot } from './types';

/**
 * User-level editing actions. Each applies ops to the doc (the caller wraps
 * it in `doc.transact`) and returns where the caret should go, or nothing if
 * focus stays put. A command that does not apply makes no ops.
 *
 * Commands take rows (RowKey: a bullet, or a bullet shown under a mirror)
 * and change the bullets they show. A Focus may name a bullet; the caller
 * finds its row nearest to where the caret was (`VisibleRows.locate`). A
 * command that moves the row elsewhere in the view returns its new key, and
 * the caret stays where it was in the text.
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

/**
 * Where children put under the bullet go: a mirror's go to its original, so
 * they show there and under every mirror of it. Null where they cannot go:
 * a mirror without its original, or inside the bullet `moving` itself.
 */
function hostFor(doc: Doc, id: NodeId, moving?: NodeId): NodeId | null {
  const host = doc.host(id)?.id ?? null;
  return host !== null && moving !== undefined && doc.within(host, moving) ? null : host;
}

/**
 * A selection's rows, one per bullet and none inside another: neither a
 * bullet inside another's (a selection over a bullet and a mirror of it
 * shows some bullets twice) nor a row under a selected mirror, whose
 * bullets are the original's and stay with it.
 */
function blockOf(doc: Doc, roots: RowKey[]): RowKey[] {
  const keys = new Set(roots);
  const ids = new Set(roots.map(nodeOf));
  const seen = new Set<NodeId>();
  return roots.filter((key) => {
    const id = nodeOf(key);
    if (seen.has(id)) return false;
    seen.add(id);
    for (let c = contextOf(key); c; c = contextOf(c)) if (keys.has(c)) return false;
    for (let p = doc.get(id).parent; p !== null; p = doc.get(p).parent) if (ids.has(p)) return false;
    return true;
  });
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

/** Deleting a bullet moves it into the trash, keyed by the time (see TRASH in doc.ts). */
function remove(doc: Doc, id: NodeId): void {
  const n = doc.get(id);
  doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: TRASH, order: trashKey(clock.now()) } });
}

function expand(doc: Doc, id: NodeId): void {
  const n = doc.get(id);
  if (n.collapsed) doc.apply({ t: 'setCollapsed', id, from: true, to: false });
}

// Text, note and task state belong to the bullet a row shows (`Doc.content`).
// A mirror's own row is a heading to read: its text and note change only
// where the original is, so taking a mirror out or typing over it never
// touches the original. Task state does change through it (the checkbox),
// and so do the bullets below it, which are the original's.

/** Is the row a mirror's own (its heading, not a bullet shown under it)? */
const mirrorHeading = (doc: Doc, key: RowKey) => doc.get(nodeOf(key)).mirrorOf !== null;

export function setText({ doc }: Ctx, id: RowKey, text: string): void {
  if (mirrorHeading(doc, id)) return;
  const n = doc.content(nodeOf(id));
  if (n.text !== text) doc.apply({ t: 'setText', id: n.id, from: n.text, to: text, at: clock.now() });
}

export function setNote({ doc }: Ctx, id: RowKey, note: string): void {
  if (mirrorHeading(doc, id)) return;
  const n = doc.content(nodeOf(id));
  if (n.note !== note) doc.apply({ t: 'setNote', id: n.id, from: n.note, to: note, at: clock.now() });
}

/**
 * `((title))` completed in a bullet: the bullet becomes a mirror of
 * `target` when nothing else is written in it; otherwise the token leaves
 * the text and the mirror goes in as the next sibling. A chain of mirrors
 * is flattened to the original; a bullet never mirrors itself.
 */
export function makeMirror(ctx: Ctx, key: RowKey, target: NodeId, start: number, end: number): Focus | void {
  const { doc } = ctx;
  const id = nodeOf(key);
  const n = doc.get(id);
  const origin = doc.origin(target);
  if (origin === id || origin === doc.root || origin === TRASH) return;
  const rest = n.text.slice(0, start) + n.text.slice(end);
  if (!rest.trim() && !n.mirrorOf && !n.note && !n.children.length) {
    setText(ctx, id, '');
    if (n.todo) untask(ctx, [id]);
    doc.apply({ t: 'setMirror', id, from: null, to: origin });
    return { id: key, caret: doc.content(id).text.length };
  }
  setText(ctx, id, rest);
  const mirror = insertNew(doc, n.parent!, doc.index(id) + 1, '', origin);
  return { id: mirror, caret: doc.content(mirror).text.length };
}

/**
 * Ctrl+L: completes the bullets, or un-completes them if all are done
 * already (for a selection: one press sets them all the same way).
 */
export function toggleDone({ doc }: Ctx, ids: RowKey[]): void {
  const value = !ids.every((id) => doc.content(nodeOf(id)).done);
  for (const id of ids) {
    const n = doc.content(nodeOf(id));
    if (n.done !== value) doc.apply({ t: 'setDone', id: n.id, from: !value, to: value });
  }
}

/**
 * Ctrl+L: a plain bullet becomes a task (an empty checkbox); a task is
 * checked or unchecked. For several bullets: any plain ones become tasks
 * first; once all are tasks, they are checked (or all unchecked).
 */
export function cycleTask(ctx: Ctx, ids: RowKey[]): void {
  const { doc } = ctx;
  const plain = [...new Set(ids.map((id) => doc.content(nodeOf(id))))].filter((n) => !n.todo);
  if (plain.length) for (const n of plain) doc.apply({ t: 'setTodo', id: n.id, from: false, to: true });
  else toggleDone(ctx, ids);
}

/** Ctrl+Shift+L: tasks become plain bullets again (and so not done). */
export function untask({ doc }: Ctx, ids: RowKey[]): void {
  for (const n of new Set(ids.map((id) => doc.content(nodeOf(id))))) {
    if (n.done) doc.apply({ t: 'setDone', id: n.id, from: true, to: false });
    if (n.todo) doc.apply({ t: 'setTodo', id: n.id, from: true, to: false });
  }
}

/** Folds the row's bullet; a mirror folds on its own, apart from its original. */
export function setCollapsed({ doc }: Ctx, key: RowKey, value: boolean): void {
  const n = doc.get(nodeOf(key));
  if ((doc.host(n.id)?.children.length ?? 0) > 0 && n.collapsed !== value) {
    doc.apply({ t: 'setCollapsed', id: n.id, from: n.collapsed, to: value });
  }
}

/** Collapses every child of `parent` that has children of its own (the logo: home, all folded). */
export function collapseChildren({ doc, rows }: Ctx, parent: NodeId): void {
  const targets = doc.get(parent).children.filter((id) => {
    const n = doc.get(id);
    return (doc.host(id)?.children.length ?? 0) > 0 && !n.collapsed;
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

/**
 * Enter: split the bullet at the caret (a mirror's heading stays whole);
 * with children shown, the new bullet is the first of them (in a mirror:
 * of the original's), otherwise a plain sibling.
 */
export function split({ doc, rows }: Ctx, key: RowKey, caret: number): Focus {
  const id = nodeOf(key);
  const n = doc.get(id);
  const c = doc.content(id);
  const parent = n.parent!;
  if (caret === 0 && c.text.length > 0) {
    insertNew(doc, parent, doc.index(id), '');
    return { id: key, caret: 0 };
  }
  // A mirror's heading is not split: Enter anywhere in it adds an empty bullet.
  const after = n.mirrorOf ? '' : c.text.slice(caret);
  setText({ doc, rows }, id, c.text.slice(0, caret));
  const host = rows.host(key);
  // Open (even with all its children completed and hidden): the new bullet is its first child.
  if (host && rows.unfolded(key)) {
    return { id: insertNew(doc, host.id, 0, after), caret: 0 };
  }
  return { id: insertNew(doc, parent, doc.index(id) + 1, after), caret: 0 };
}

/** Snapshot of a tree as new nodes: fresh ids, sequential order keys. */
function snapshotOf(tree: Tree, order: string, now: number): NodeSnapshot {
  let prev: string | null = null;
  return {
    id: newId(), order, text: tree.text, note: tree.note ?? '', collapsed: tree.collapsed ?? false,
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
export function insertTrees(ctx: Ctx, key: RowKey, start: number, end: number, trees: Tree[]): Focus {
  const { doc, rows } = ctx;
  const id = nodeOf(key);
  const n = doc.get(id);
  const text = doc.content(id).text;
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (!trees.length) {
    setText(ctx, id, before + after);
    return { id: key, caret: start };
  }
  if (countTrees(trees) > 2) rows.expectMany();
  const now = clock.now();
  // The first tree's children go to the original of a mirror; one without it takes them as bullets below.
  const host = hostFor(doc, id);
  if (host === null && trees[0].children.length) trees = [{ ...trees[0], children: [] }, ...trees[0].children, ...trees.slice(1)];
  const last = trees.length - 1;
  const [first] = trees;
  setText(ctx, id, before + first.text + (last === 0 ? after : ''));
  first.children.forEach((c, k) => doc.apply({ t: 'insert', parent: host!, node: snapshotOf(c, doc.orderAt(host!, k), now) }));
  let focus: Focus = { id: key, caret: before.length + first.text.length };
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
export function insertText(ctx: Ctx, id: RowKey, start: number, end: number, lines: string[]): Focus {
  return insertTrees(ctx, id, start, end, lines.map((text) => ({ text, children: [] })));
}

/** Import: the trees become the last children of `parent`. Focuses the first one. */
export function appendTrees(ctx: Ctx, parent: NodeId, trees: Tree[]): Focus | void {
  return placeTrees(ctx, parent, ctx.doc.get(parent).children.length, trees);
}

/** The trees become children of `parent` from `index` on, one insert each. Focuses the first one. */
export function placeTrees({ doc, rows }: Ctx, parent: NodeId, index: number, trees: Tree[]): Focus | void {
  if (countTrees(trees) > 2) rows.expectMany();
  const now = clock.now();
  let first: NodeId | undefined;
  for (const tree of trees) {
    const node = snapshotOf(tree, doc.orderAt(parent, index++), now);
    doc.apply({ t: 'insert', parent, node });
    first ??= node.id;
  }
  if (first) return { id: first, caret: 0 };
}

/**
 * Backspace at the start of a bullet: remove it if empty, otherwise append
 * its text to the previous visible row. Bullets with children or a note are
 * left alone so nothing gets lost. A mirror goes whatever it shows: only the
 * link goes, the original stays.
 */
export function mergeUp({ doc, rows }: Ctx, key: RowKey): Focus | void {
  const id = nodeOf(key);
  const n = doc.get(id);
  const c = doc.content(id);
  const i = rows.indexOf(key);
  if (i <= 0) return;
  const prevKey = rows.ids[i - 1];
  const prevId = nodeOf(prevKey);
  const prev = doc.content(prevId);
  const caret = prev.text.length;
  // A mirror is a link: Backspace at its start takes out the link alone; the original keeps its text, note and bullets.
  if (n.mirrorOf) {
    remove(doc, id);
    return { id: prevKey, caret };
  }
  if (n.children.length > 0 || c.note) return;
  // Nothing is merged into a mirror's heading: its text is the original's.
  if (c.text && doc.get(prevId).mirrorOf) return;
  // The row above may show the same bullet (a mirror right below its original): nothing to join.
  if (c.text && prev === c) return;
  if (c.text) setText({ doc, rows }, prevId, prev.text + c.text);
  remove(doc, id);
  return { id: prevKey, caret };
}

/** Delete a bullet with its subtree. The outline never becomes empty. */
export function deleteNode({ doc, rows }: Ctx, key: RowKey): Focus | void {
  const i = rows.indexOf(key);
  const prev = i > 0 ? rows.ids[i - 1] : null;
  const end = i >= 0 ? rows.subtreeEnd(i) : -1;
  const next = i >= 0 && end < rows.length ? rows.ids[end] : null;
  remove(doc, nodeOf(key));
  if (doc.get(doc.root).children.length === 0) return { id: insertNew(doc, doc.root, 0, ''), caret: 0 };
  if (prev) return { id: prev, caret: doc.content(nodeOf(prev)).text.length };
  if (next) return { id: next, caret: 0 };
}

/**
 * Tab: become the last child of the previous sibling (of a mirror: of its
 * original, so the row stays right under the mirror). Returns the row's new key.
 */
export function indent({ doc, rows }: Ctx, key: RowKey): RowKey | void {
  const id = nodeOf(key);
  const i = doc.index(id);
  if (i === 0) return;
  const prevId = doc.get(doc.get(id).parent!).children[i - 1];
  const host = hostFor(doc, prevId, id);
  if (host === null) return;
  expand(doc, prevId);
  moveTo(doc, id, host, doc.get(host).children.length);
  return rows.childKey(keyIn(contextOf(key), prevId), id);
}

/**
 * The row the row `key` shows under, unless that is the top level (the
 * root, or the zoomed-in bullet): a bullet, or a mirror for the rows right
 * under it.
 */
function parentRow(rows: VisibleRows, doc: Doc, key: RowKey): { key: RowKey; id: NodeId; parent: NodeId } | null {
  const pk = rows.parentKey(key);
  if (pk === null) return null;
  const id = nodeOf(pk);
  const parent = doc.get(id).parent;
  return parent === null ? null : { key: pk, id, parent };
}

/**
 * Shift+Tab: become the next sibling of the row it shows under (right under
 * a mirror: of the mirror, so it leaves the original and stays in view).
 * Later siblings stay where they are. Never leaves the zoomed-in bullet.
 */
export function outdent({ doc, rows }: Ctx, key: RowKey): RowKey | void {
  const id = nodeOf(key);
  const p = parentRow(rows, doc, key);
  if (!p || doc.within(p.parent, id)) return;
  moveTo(doc, id, p.parent, doc.index(p.id) + 1);
  return keyIn(contextOf(p.key), id);
}

/**
 * Swap with the previous sibling; the first child moves to the end of the
 * parent row's previous sibling. Returns the row's new key.
 */
export function moveUp({ doc, rows }: Ctx, key: RowKey): RowKey | void {
  const id = nodeOf(key);
  const parent = doc.get(doc.get(id).parent!);
  const i = parent.children.indexOf(id);
  if (i > 0) return moveTo(doc, id, parent.id, i - 1);
  const p = parentRow(rows, doc, key);
  if (!p) return;
  const pi = doc.index(p.id);
  if (pi === 0) return;
  const target = doc.get(p.parent).children[pi - 1];
  const host = hostFor(doc, target, id);
  if (host === null) return;
  expand(doc, target);
  moveTo(doc, id, host, doc.get(host).children.length);
  return rows.childKey(keyIn(contextOf(p.key), target), id);
}

/** Swap with the next sibling; the last child moves to the start of the parent row's next sibling. */
export function moveDown({ doc, rows }: Ctx, key: RowKey): RowKey | void {
  const id = nodeOf(key);
  const parent = doc.get(doc.get(id).parent!);
  const i = parent.children.indexOf(id);
  if (i < parent.children.length - 1) return moveTo(doc, id, parent.id, i + 2);
  const p = parentRow(rows, doc, key);
  if (!p) return;
  const uncles = doc.get(p.parent).children;
  const pi = uncles.indexOf(p.id);
  if (pi === uncles.length - 1) return;
  const target = uncles[pi + 1];
  const host = hostFor(doc, target, id);
  if (host === null) return;
  expand(doc, target);
  moveTo(doc, id, host, 0);
  return rows.childKey(keyIn(contextOf(p.key), target), id);
}

// --- Several bullets at once (a selection) -----------------------------------
// `roots` are the selected bullets that are not inside another selected one,
// in document order; each one moves with its subtree.

/** Can `moveUp` move this row (inside the zoom)? */
function canMoveUp({ doc, rows }: Ctx, key: RowKey): boolean {
  const id = nodeOf(key);
  if (doc.index(id) > 0) return true;
  const p = parentRow(rows, doc, key);
  if (!p || doc.index(p.id) === 0) return false;
  return hostFor(doc, doc.get(p.parent).children[doc.index(p.id) - 1], id) !== null;
}

function canMoveDown({ doc, rows }: Ctx, key: RowKey): boolean {
  const id = nodeOf(key);
  const parent = doc.get(doc.get(id).parent!);
  if (doc.index(id) < parent.children.length - 1) return true;
  const p = parentRow(rows, doc, key);
  if (!p) return false;
  const uncles = doc.get(p.parent).children;
  const pi = doc.index(p.id);
  return pi < uncles.length - 1 && hostFor(doc, uncles[pi + 1], id) !== null;
}

/** Deletes the bullets with their subtrees; focuses the row above them, or below. */
export function deleteMany(ctx: Ctx, roots: RowKey[]): Focus | void {
  const { doc, rows } = ctx;
  if (!roots.length) return;
  const first = rows.indexOf(roots[0]);
  const lastRow = rows.indexOf(roots[roots.length - 1]);
  const prev = first > 0 ? rows.ids[first - 1] : null;
  const end = lastRow >= 0 ? rows.subtreeEnd(lastRow) : -1;
  const next = end >= 0 && end < rows.length ? rows.ids[end] : null;
  if (roots.length > 1) rows.expectMany();
  for (const key of blockOf(doc, roots)) remove(doc, nodeOf(key));
  if (doc.get(doc.root).children.length === 0) return { id: insertNew(doc, doc.root, 0, ''), caret: 0 };
  if (prev) return { id: prev, caret: doc.content(nodeOf(prev)).text.length };
  if (next) return { id: next, caret: 0 };
}

/**
 * Tab on a block: each bullet goes under its previous sibling, so consecutive
 * ones stay together. If the first one cannot be indented, the block stays:
 * indenting only its tail would tear it apart.
 */
export function indentMany(ctx: Ctx, rows: RowKey[]): void {
  const roots = blockOf(ctx.doc, rows);
  if (!roots.length || ctx.doc.index(nodeOf(roots[0])) === 0) return;
  for (const id of roots) indent(ctx, id);
}

/** Shift+Tab on a block: from the last bullet up, so their order is kept. */
export function outdentMany(ctx: Ctx, rows: RowKey[]): void {
  const roots = blockOf(ctx.doc, rows);
  for (let k = roots.length - 1; k >= 0; k--) outdent(ctx, roots[k]);
}

/** Moves the block up by one place, whole; nothing if its first bullet cannot move. */
export function moveUpMany(ctx: Ctx, rows: RowKey[]): void {
  const roots = blockOf(ctx.doc, rows);
  if (!roots.length || !canMoveUp(ctx, roots[0])) return;
  for (const id of roots) moveUp(ctx, id);
}

export function moveDownMany(ctx: Ctx, rows: RowKey[]): void {
  const roots = blockOf(ctx.doc, rows);
  if (!roots.length || !canMoveDown(ctx, roots[roots.length - 1])) return;
  for (let k = roots.length - 1; k >= 0; k--) moveDown(ctx, roots[k]);
}

/**
 * Drag and drop: moves the rows' bullets, with their subtrees and in their
 * order, under the row `parentKey` (a mirror: under its original) right
 * after its child `afterKey` (null: first). Refuses a drop
 * inside one of the moved subtrees. The new order keys lie strictly between
 * two neighbouring keys that exist now, so they can never clash with a key a
 * moving bullet still holds.
 */
export function moveManyTo({ doc, rows }: Ctx, keys: RowKey[], parentKey: RowKey, afterKey: RowKey | null): void {
  // Under a mirror row, into its original.
  const target = hostFor(doc, nodeOf(parentKey));
  if (target === null) return;
  const parent: NodeId = target;
  const after = afterKey === null ? null : nodeOf(afterKey);
  const ids = blockOf(doc, keys).map(nodeOf);
  const moving = new Set(ids);
  for (let p: NodeId | null = parent; p !== null; p = doc.get(p).parent) if (moving.has(p)) return;
  const children = doc.get(parent).children;
  let k = after === null ? -1 : children.indexOf(after);
  while (k >= 0 && moving.has(children[k])) k--; // dropped right after a moving bullet: after its predecessor
  const orders = doc.ordersAt(parent, k + 1, ids.length);
  if (ids.length > 2) rows.expectMany();
  if (nodeOf(parentKey) !== doc.root) expand(doc, nodeOf(parentKey));
  ids.forEach((id, i) => {
    const n = doc.get(id);
    doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent, order: orders[i] } });
  });
}

