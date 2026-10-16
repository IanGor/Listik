/// <reference lib="webworker" />
import { compactLog } from './compact';
import { openDb } from './db';

/** Compacts the named database off the main thread; replies with the number of ops folded. */
self.onmessage = async (e: MessageEvent<{ name: string }>) => {
  try {
    const db = await openDb(e.data.name);
    try {
      self.postMessage({ folded: await compactLog(db) });
    } finally {
      db.close();
    }
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
