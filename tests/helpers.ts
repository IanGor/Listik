import { Doc } from '../src/model/doc';
import { VisibleRows } from '../src/model/rows';
import type { Ctx } from '../src/model/commands';
import type { NodeId } from '../src/model/types';

/**
 * Builds a doc from indented lines (2 spaces per level). A node's text is
 * also its id, so fixtures must use unique texts. A trailing " [+]" marks
 * the node collapsed.
 */
export function build(lines: string[]): Doc {
  const doc = new Doc();
  const parents: NodeId[] = [doc.root];
  for (const line of lines) {
    const depth = (line.length - line.trimStart().length) / 2;
    let text = line.trim();
    const collapsed = text.endsWith(' [+]');
    if (collapsed) text = text.slice(0, -4);
    const parent = parents[depth];
    doc.apply({
      t: 'insert',
      parent,
      node: {
        id: text, order: doc.orderAt(parent, doc.get(parent).children.length), text, note: '', collapsed,
        todo: false, done: false, created: 0, updated: 0, children: [],
      },
    });
    parents[depth + 1] = text;
    parents.length = depth + 2;
  }
  return doc;
}

const line = (doc: Doc, id: NodeId, depth: number) => {
  const n = doc.get(id);
  return '  '.repeat(depth) + n.text + (n.collapsed ? ' [+]' : '');
};

/** The whole tree, including collapsed subtrees, in `build` format. */
export function dump(doc: Doc): string[] {
  const out: string[] = [];
  const walk = (id: NodeId, depth: number) => {
    out.push(line(doc, id, depth));
    for (const c of doc.get(id).children) walk(c, depth + 1);
  };
  for (const c of doc.get(doc.root).children) walk(c, 0);
  return out;
}

/** Only the visible rows, in `build` format. */
export function dumpRows(rows: VisibleRows, doc: Doc): string[] {
  return rows.ids.map((id, i) => line(doc, id, rows.depths[i]));
}

export function setup(lines: string[]) {
  const doc = build(lines);
  const rows = new VisibleRows(doc);
  const ctx: Ctx = { doc, rows };
  return { doc, rows, ctx, run: <T>(fn: () => T) => {
    let result!: T;
    doc.transact(() => { result = fn(); });
    return result;
  } };
}

export { rng } from '../src/util/rng';
