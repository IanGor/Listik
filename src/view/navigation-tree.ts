import type { Doc } from '../model/doc';
import { nodeOf, type RowKey } from '../model/rows';

export interface NavigationRow {
  key: RowKey;
  id: string;
  depth: number;
  parent: RowKey | null;
  children: boolean;
  position: number;
  siblings: number;
}

/** Read-only projection: folds never touch the document or the editor's rows. */
export function navigationRows(doc: Doc, expanded: ReadonlySet<RowKey>): NavigationRow[] {
  const out: NavigationRow[] = [];
  const stack = [{ children: doc.get(doc.root).children, index: 0, depth: 0, parent: null as RowKey | null, hosts: new Set([doc.root]) }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.children.length) { stack.pop(); continue; }
    const id = frame.children[frame.index++];
    const key = frame.parent ? `${frame.parent}/${id}` : id;
    const host = doc.host(id);
    const children = !!host?.children.length && !frame.hosts.has(host.id);
    out.push({ key, id, depth: frame.depth, parent: frame.parent, children, position: frame.index, siblings: frame.children.length });
    if (children && expanded.has(key)) stack.push({
      children: host!.children, index: 0, depth: frame.depth + 1, parent: key,
      hosts: new Set([...frame.hosts, host!.id]),
    });
  }
  return out;
}

/** Reveal only the physical ancestor path; never close a neighbouring branch. */
export function revealNavigation(doc: Doc, id: string, expanded: ReadonlySet<RowKey>): Set<RowKey> {
  const next = new Set(expanded);
  if (!doc.has(id) || !doc.inOutline(id)) return next;
  const path: string[] = [];
  for (let p = doc.get(id).parent; p !== null && p !== doc.root; p = doc.get(p).parent) path.push(p);
  let key = '';
  for (const parent of path.reverse()) {
    key = key ? `${key}/${parent}` : parent;
    next.add(key);
  }
  return next;
}

/** A visible ancestor remains selected when the user folds the active branch. */
export function navigationSelection(rows: NavigationRow[], doc: Doc, active: string | null, preferred?: RowKey): RowKey | null {
  if (!active || !doc.has(active)) return null;
  if (preferred && doc.has(nodeOf(preferred)) && doc.origin(nodeOf(preferred)) === active) {
    let key = preferred;
    while (key) {
      if (rows.some((r) => r.key === key)) return key;
      const slash = key.lastIndexOf('/');
      key = slash < 0 ? '' : key.slice(0, slash);
    }
  }
  const exact = rows.find((r) => r.id === active);
  if (exact) return exact.key;
  let p = doc.get(active).parent;
  while (p !== null && p !== doc.root) {
    const row = rows.find((r) => nodeOf(r.key) === p);
    if (row) return row.key;
    p = doc.get(p).parent;
  }
  return rows.find((r) => doc.origin(r.id) === active)?.key ?? null;
}
