import type { Ctx } from './commands';
import { TRASH, trashKey, trashTime, type Doc } from './doc';
import type { NodeId } from './types';

/** How long a deleted bullet stays in the trash before compaction purges it. */
export const TRASH_TTL = 30 * 24 * 60 * 60_000;

/**
 * Destroys trash entries thrown away before `cutoff` (their order key is the
 * time, see `trashKey`). Purging is local to each device and never
 * synchronized: an op about a purged bullet is simply dropped (merge.ts).
 */
export function purgeTrash(doc: Doc, cutoff: number): number {
  const old = doc.get(TRASH).children.filter((id) => trashTime(doc.get(id).order) < cutoff);
  for (const id of old) doc.apply({ t: 'remove', parent: TRASH, node: doc.snapshot(id) });
  return old.length;
}

const SEP = '|';

/**
 * The trash order key of a bullet deleted from `parent` at `order`: the time
 * first (it sorts and purges by it, `trashTime` reads only that), then where
 * it was, so "Вернуть" can put it back. Order keys and ids never hold SEP.
 * It is part of the move op, so the place travels with sync and lasts
 * through compaction. Bullets put in the trash otherwise (an undone
 * creation, another device's deletion merged) have a bare time key.
 */
export const deletedKey = (time: number, parent: NodeId, order: string): string => [trashKey(time), order, parent].join(SEP);

/** Where a deleted bullet was, from its trash order key; null for a bare time key. */
export function deletedFrom(key: string): { parent: NodeId; order: string } | null {
  const parts = key.split(SEP);
  return parts.length === 3 ? { order: parts[1], parent: parts[2] } : null;
}

/** An entry of the trash as the trash panel lists it. */
export interface Deleted {
  id: NodeId;
  /** When it was deleted, ms. */
  at: number;
  from: { parent: NodeId; order: string };
}

/**
 * What was deleted, newest first: each deleted block once, with its subtree.
 * An empty bullet with nothing in it (an empty line taken out) is left out,
 * and so is anything that came to the trash otherwise than by deleting.
 */
export function deletedEntries(doc: Doc): Deleted[] {
  const out: Deleted[] = [];
  const kids = doc.get(TRASH).children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const n = doc.get(kids[i]);
    const from = deletedFrom(n.order);
    if (!from) continue;
    const c = doc.content(n.id);
    if (!n.mirrorOf && !c.text.trim() && !c.note.trim() && !n.children.length) continue;
    out.push({ id: n.id, at: trashTime(n.order), from });
  }
  return out;
}

/** Can the bullet still go back where it was: is that place in the outline? */
export function placeIsThere(doc: Doc, parent: NodeId): boolean {
  return doc.has(parent) && doc.inOutline(parent);
}

/**
 * "Вернуть": the deleted bullet, with its subtree, goes back where it was,
 * between the same neighbours. When that place is gone (deleted too, or
 * purged), it goes last at the top level. Returns whether it went home;
 * null if it is not in the trash.
 */
export function restoreDeleted({ doc }: Ctx, id: NodeId): { home: boolean } | null {
  const n = doc.nodes.get(id);
  if (!n || n.parent !== TRASH) return null;
  const from = deletedFrom(n.order);
  // Children go where the bullet's own are (a mirror's to its original).
  const host = from && placeIsThere(doc, from.parent) ? doc.host(from.parent)?.id ?? null : null;
  const to = host !== null && from
    ? { parent: host, order: from.order }
    : { parent: doc.root, order: doc.orderAt(doc.root, doc.get(doc.root).children.length) };
  doc.apply({ t: 'move', id, from: { parent: TRASH, order: n.order }, to });
  return { home: host !== null };
}
