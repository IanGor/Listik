/**
 * One writer per document. The tab that gets the document's Web Lock holds
 * it for its whole life; any other tab is read-only, and `onReleased` runs
 * there once the writer is gone (closed or reloaded). Without Web Locks
 * (very old browsers) every tab writes, as before.
 */
export async function acquireWriteLock(name: string, onReleased: () => void): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) return true;
  const key = `listik:${name}`;
  const held = await new Promise<boolean>((resolve) => {
    void navigator.locks.request(key, { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      // Returning a promise that never settles keeps the lock until the page goes away.
      return lock ? new Promise<never>(() => {}) : undefined;
    });
  });
  if (!held) {
    void navigator.locks.request(key, () => {
      onReleased();
      return new Promise<never>(() => {});
    });
  }
  return held;
}
