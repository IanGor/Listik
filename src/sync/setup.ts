import type { Doc } from '../model/doc';
import { encryptedCodec, plainCodec, type Codec } from '../persist/codec';
import { openDb } from '../persist/db';
import type { Persistence } from '../persist/idb';
import { HttpError, httpTransport, normalizeServer, type Transport } from './client';
import { createKeyslot, dataKey, deriveKek, newDocId, openKeyslot, rewrapKeyslot, tokenFromKek, type Keyslot } from './crypto';
import { SyncEngine, bootstrap, writeSyncState } from './engine';
import {
  forgetSecret, readKeyslot, readSyncConfig, recallSecret, rememberSecret, writeKeyslot, writeSyncConfig, type Secret, type SyncConfig,
} from './vault';

/**
 * The flows behind the sync dialog and the unlock screen, over the pieces in
 * crypto.ts, vault.ts and engine.ts. All of them work on the document's
 * database by name; the page keeps one handle open (`SyncHandle`).
 */

/** What a page needs to read an encrypted document, or to know it is locked. */
export interface Opened {
  db: IDBDatabase;
  config: SyncConfig | null;
  keyslot: Keyslot | null;
  /** Null while the passphrase is still needed. */
  secret: Secret | null;
}

export async function openVault(name: string): Promise<Opened> {
  const db = await openDb(name);
  const [config, keyslot] = await Promise.all([readSyncConfig(db), readKeyslot(db)]);
  const secret = keyslot ? await recallSecret(db) : null;
  return { db, config: config ?? null, keyslot: keyslot ?? null, secret };
}

/** The passphrase typed on the unlock screen. Throws on a wrong one. */
export async function unlock(opened: Opened, passphrase: string, remember: boolean): Promise<Secret> {
  if (!opened.keyslot || !opened.config) throw new Error('Документ не зашифрован');
  const secret = await openKeyslot(passphrase, opened.config.docId, opened.keyslot);
  if (remember) await rememberSecret(opened.db, secret);
  opened.secret = secret;
  return secret;
}

export async function codecFor(secret: Secret | null): Promise<Codec> {
  return secret ? encryptedCodec(await dataKey(secret.dek)) : plainCodec;
}

/** A live sync session of the writing tab. */
export interface SyncHandle {
  engine: SyncEngine;
  config: SyncConfig;
  secret: Secret;
  db: IDBDatabase;
  transport: Transport;
}

export async function startSync(doc: Doc, opened: Opened): Promise<SyncHandle | null> {
  const { db, config, secret } = opened;
  if (!config || !secret) return null;
  const transport = httpTransport(config.server, config.docId, secret.token);
  const engine = await SyncEngine.open(doc, db, transport, await dataKey(secret.dek), config.docId);
  engine.start();
  return { engine, config, secret, db, transport };
}

/**
 * Makes this document the shared one: a new document on the server with a
 * fresh key, the local store re-encrypted, the current outline uploaded as
 * the first snapshot. The passphrase is remembered on this device.
 */
export async function createSync(doc: Doc, opened: Opened, persistence: Persistence, server: string, passphrase: string): Promise<SyncHandle> {
  const docId = newDocId();
  const { keyslot, dek, token } = await createKeyslot(passphrase, docId);
  const transport = httpTransport(server, docId, token);
  let created: boolean;
  try {
    ({ created } = await transport.putKeyslot(keyslot));
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) throw new Error('Сервер не принимает новые документы (LISTIK_ALLOW_CREATE=0)');
    if (e instanceof HttpError && e.status === 429) throw new Error('Сервер временно не отвечает на попытки подключения: слишком много неудачных');
    throw e;
  }
  if (!created) throw new Error('Такой документ на сервере уже есть');
  const config = { server: normalizeServer(server), docId };
  await writeKeyslot(opened.db, keyslot);
  await writeSyncConfig(opened.db, config);
  const secret = { dek, token };
  await rememberSecret(opened.db, secret);
  opened.config = config;
  opened.keyslot = keyslot;
  opened.secret = secret;
  const key = await dataKey(dek);
  await persistence.recode(encryptedCodec(key));
  const engine = await SyncEngine.open(doc, opened.db, transport, key, docId);
  await engine.uploadSnapshot();
  engine.start();
  return { engine, config, secret, db: opened.db, transport };
}

/**
 * Connects this browser to a document that exists on the server: the local
 * document is replaced by the server's snapshot. Reload the page after.
 */
export async function joinSync(opened: Opened, persistence: Persistence | null, server: string, docId: string, passphrase: string): Promise<void> {
  const kek = await deriveKek(passphrase, docId);
  const token = await tokenFromKek(kek);
  const transport = httpTransport(server, docId, token);
  let keyslot: Keyslot;
  try {
    keyslot = await transport.getKeyslot();
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw new Error('Сервер временно не отвечает на попытки подключения: слишком много неудачных');
    if (e instanceof HttpError && (e.status === 401 || e.status === 404)) throw new Error('Документ с таким кодом и паролем на сервере не найден');
    throw e;
  }
  const { dek } = await openKeyslot(passphrase, docId, keyslot);
  const key = await dataKey(dek);
  await persistence?.flush();
  await writeSyncState(opened.db, undefined); // a fresh replica: nothing pending from before
  await bootstrap(opened.db, encryptedCodec(key), key, docId, transport);
  await writeKeyslot(opened.db, keyslot);
  await writeSyncConfig(opened.db, { server: normalizeServer(server), docId });
  await rememberSecret(opened.db, { dek, token });
}

/** Stops syncing and decrypts the local store; the server keeps its copy. */
export async function disconnectSync(handle: SyncHandle, persistence: Persistence, opened: Opened): Promise<void> {
  handle.engine.stop();
  await writeSyncConfig(opened.db, undefined);
  await writeKeyslot(opened.db, undefined);
  await writeSyncState(opened.db, undefined);
  await forgetSecret(opened.db);
  opened.config = opened.keyslot = null;
  opened.secret = null;
  await persistence.recode(plainCodec);
}

/** The passphrase will be asked on the next load of this document here. */
export const forgetOnDevice = (opened: Opened) => forgetSecret(opened.db);

/** Re-wraps the document key for a new passphrase, here and on the server. Reload after: the token changed. */
export async function changePassphrase(handle: SyncHandle, opened: Opened, passphrase: string): Promise<void> {
  const { keyslot, token } = await rewrapKeyslot(passphrase, handle.config.docId, handle.secret.dek);
  await handle.transport.putKeyslot(keyslot, token);
  await writeKeyslot(opened.db, keyslot);
  await rememberSecret(opened.db, { dek: handle.secret.dek, token });
}
