/// <reference lib="webworker" />
import { codecForKey, recoding } from './codec';
import { compactLog } from './compact';
import { openDb } from './db';

/**
 * Compacts the named database off the main thread; replies with the number
 * of ops folded. `key` is the data key of an encrypted document (CryptoKeys
 * cross to workers by structured clone); `old` is set while recoding and
 * carries the key being replaced, so records stored with it are read too;
 * `force` rewrites the snapshot even with an empty log, which is how a
 * document is first encrypted.
 */
self.onmessage = async (e: MessageEvent<{ name: string; key?: CryptoKey; old?: { key?: CryptoKey }; force?: boolean }>) => {
  try {
    const db = await openDb(e.data.name);
    try {
      const codec = e.data.old ? recoding(codecForKey(e.data.key), codecForKey(e.data.old.key)) : codecForKey(e.data.key);
      self.postMessage({ folded: await compactLog(db, codec, e.data.force) });
    } finally {
      db.close();
    }
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
