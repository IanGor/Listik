import { getMeta, putMeta } from '../persist/db';
import {
  deviceKey, openForDevice, sealForDevice, type Encrypted, type Keyslot,
} from './crypto';

/**
 * What a document remembers about its keys and its server, in the `meta`
 * store next to the snapshot:
 * - `sync`: the server and the document code, once sync is set up;
 * - `keyslot`: the document key wrapped by the passphrase (a copy of what
 *   the server holds), so an unlock never needs the network;
 * - `device`: a non-extractable key of this browser and the document key
 *   and token sealed with it ("remember on this device"). Without it the
 *   passphrase is asked on every load.
 */
export interface SyncConfig {
  server: string;
  docId: string;
}

export interface Secret {
  dek: Uint8Array;
  token: string;
}

interface DeviceRecord {
  key: CryptoKey;
  sealed: Encrypted;
}

export const readSyncConfig = (db: IDBDatabase) => getMeta<SyncConfig>(db, 'sync');
export const writeSyncConfig = (db: IDBDatabase, c: SyncConfig | undefined) => putMeta(db, 'sync', c);
export const readKeyslot = (db: IDBDatabase) => getMeta<Keyslot>(db, 'keyslot');
export const writeKeyslot = (db: IDBDatabase, k: Keyslot | undefined) => putMeta(db, 'keyslot', k);

/** The secret, if this device remembers it. */
export async function recallSecret(db: IDBDatabase): Promise<Secret | null> {
  const rec = await getMeta<DeviceRecord>(db, 'device');
  if (!rec) return null;
  try {
    return await openForDevice(rec.key, rec.sealed);
  } catch {
    return null;
  }
}

export async function rememberSecret(db: IDBDatabase, secret: Secret): Promise<void> {
  const key = await deviceKey();
  await putMeta(db, 'device', { key, sealed: await sealForDevice(key, secret) } satisfies DeviceRecord);
}

export const forgetSecret = (db: IDBDatabase) => putMeta(db, 'device', undefined);
