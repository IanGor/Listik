import { TRASH, trashTime, type Doc } from './doc';

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
