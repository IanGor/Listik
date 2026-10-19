/// <reference lib="webworker" />
import { encryptedCodec, plainCodec } from './codec';
import { compactLog } from './compact';
import { openDb } from './db';

/**
 * Compacts the named database off the main thread; replies with the number
 * of ops folded. `key` is the data key of an encrypted document (CryptoKeys
 * cross to workers by structured clone); `force` rewrites the snapshot even
 * with an empty log, which is how a document is first encrypted.
 */
self.onmessage = async (e: MessageEvent<{ name: string; key?: CryptoKey; force?: boolean }>) => {
  try {
    const db = await openDb(e.data.name);
    try {
      const codec = e.data.key ? encryptedCodec(e.data.key) : plainCodec;
      self.postMessage({ folded: await compactLog(db, codec, e.data.force) });
    } finally {
      db.close();
    }
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
