/** Above this, `splice(at, n, ...items)` risks overflowing the call stack. */
const SPREAD_LIMIT = 10_000;

/**
 * `arr.splice(at, remove, ...items)` that is safe for any number of items.
 * Returns the resulting array, which may be a new one.
 */
export function spliceAll<T>(arr: T[], at: number, remove: number, items: readonly T[]): T[] {
  if (items.length <= SPREAD_LIMIT) {
    arr.splice(at, remove, ...items);
    return arr;
  }
  return arr.slice(0, at).concat(items, arr.slice(at + remove));
}
