import type { Doc } from '../model/doc';
import { encryptedCodec, plainCodec, type Codec } from '../persist/codec';
import { openDb } from '../persist/db';
import type { Persistence } from '../persist/idb';
import { HttpError, httpTransport, normalizeServer, type Transport } from './client';
import { createKeyslot, dataKey, deriveKek, newDocId, openKeyslot, rewrapKeyslot, tokenFromKek, type Keyslot } from './crypto';
import { SyncEngine, bootstrap, writeSyncState, type StateStore } from './engine';
import {
  forgetSecret, readKeyslot, readRestore, readSyncConfig, recallSecret, rememberSecret, writeKeyslot, writeRestore, writeSyncConfig,
  type Secret, type SyncConfig,
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

/**
 * The passphrase typed on the unlock screen. Throws on a wrong one. A
 * passphrase the key slot here does not take may be a new one, set on
 * another device: the server's key slot is tried with it, and kept here.
 */
export async function unlock(opened: Opened, passphrase: string, remember: boolean): Promise<Secret> {
  if (!opened.keyslot || !opened.config) throw new Error('Документ не зашифрован');
  let secret: Secret;
  try {
    secret = await openKeyslot(passphrase, opened.config.docId, opened.keyslot);
  } catch (e) {
    const fresh = await fromServer(opened.config.server, opened.config.docId, passphrase).catch(() => null);
    if (!fresh) throw e;
    await writeKeyslot(opened.db, fresh.keyslot);
    opened.keyslot = fresh.keyslot;
    secret = { dek: fresh.dek, token: fresh.token };
  }
  if (remember) await rememberSecret(opened.db, secret);
  opened.secret = secret;
  return secret;
}

/** The document's key slot from the server, opened with `passphrase`; throws with a word for the user. */
async function fromServer(server: string, docId: string, passphrase: string): Promise<{ keyslot: Keyslot; dek: Uint8Array; token: string; transport: Transport }> {
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
  return { keyslot, dek, token, transport };
}

/**
 * The passphrase was changed on another device (the engine's status is
 * `refused`): the new one opens the server's key slot, which is kept here
 * with the new token. What this device has not sent yet stays in its
 * outbox. Reload after.
 */
export async function relogin(handle: SyncHandle, opened: Opened, passphrase: string): Promise<void> {
  const { keyslot, dek, token } = await fromServer(handle.config.server, handle.config.docId, passphrase);
  if (dek.length !== handle.secret.dek.length || dek.some((b, i) => b !== handle.secret.dek[i])) {
    throw new Error('Этот пароль открывает документ с другим ключом');
  }
  const remembered = (await recallSecret(opened.db)) !== null;
  await writeKeyslot(opened.db, keyslot);
  if (remembered) await rememberSecret(opened.db, { dek, token });
  opened.keyslot = keyslot;
  opened.secret = { dek, token };
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

export async function startSync(doc: Doc, opened: Opened, store: StateStore): Promise<SyncHandle | null> {
  const { db, config, secret } = opened;
  if (!config || !secret) return null;
  const transport = httpTransport(config.server, config.docId, secret.token);
  const engine = await SyncEngine.open(doc, db, transport, await dataKey(secret.dek), config.docId);
  engine.attach(store);
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
  engine.attach(persistence);
  await engine.uploadSnapshot();
  engine.start();
  return { engine, config, secret, db: opened.db, transport };
}

/**
 * Connects this browser to a document that exists on the server: the local
 * document is replaced by the server's snapshot. Reload the page after.
 */
export async function joinSync(opened: Opened, persistence: Persistence | null, server: string, docId: string, passphrase: string): Promise<void> {
  const { keyslot, dek, token, transport } = await fromServer(server, docId, passphrase);
  const key = await dataKey(dek);
  await persistence?.flush();
  await writeSyncState(opened.db, undefined); // a fresh replica: nothing pending from before
  await bootstrap(opened.db, encryptedCodec(key), key, docId, transport);
  await writeKeyslot(opened.db, keyslot);
  await writeSyncConfig(opened.db, { server: normalizeServer(server), docId });
  await rememberSecret(opened.db, { dek, token });
}

/**
 * Stops syncing and decrypts the local store; the server keeps its copy.
 * The store is decrypted before the key is forgotten: a failed decryption
 * then leaves sync switched off but the key still here, never the data
 * under a key nobody has.
 */
export async function disconnectSync(handle: SyncHandle, persistence: Persistence, opened: Opened): Promise<void> {
  handle.engine.stop();
  await persistence.recode(plainCodec);
  await writeSyncConfig(opened.db, undefined);
  await writeKeyslot(opened.db, undefined);
  await writeSyncState(opened.db, undefined);
  await forgetSecret(opened.db);
  opened.config = opened.keyslot = null;
  opened.secret = null;
}

/**
 * Rebuilds this browser's copy from the server's when the local store
 * cannot be read with the document's key (records left under another key by
 * an older version, see Persistence.recode). Edits not sent yet survive: they
 * are in the sync state's outbox, not in the unreadable records. Reload after.
 */
export async function restoreFromServer(opened: Opened): Promise<void> {
  const { db, config, secret } = opened;
  if (!config || !secret) throw new Error('Синхронизация на этом устройстве не настроена');
  const key = await dataKey(secret.dek);
  await bootstrap(db, encryptedCodec(key), key, config.docId, httpTransport(config.server, config.docId, secret.token));
}

/**
 * Asks for this browser's copy to be rebuilt from the server's on the next
 * load (`takeRestore`, then `restoreFromServer`), before anything opens the
 * store: done on a live page, the page's own writes (a late batch of the
 * log, the sync state) could land on top of the server's snapshot before the
 * reload. What is not on disk yet goes first. Reload after.
 */
export async function requestRestore(handle: SyncHandle, persistence: Persistence, opened: Opened): Promise<void> {
  await handle.engine.flush();
  await persistence.flush();
  await writeRestore(opened.db, true);
}

/** Was a rebuild from the server asked for, and can this device do it? The request is used up either way. */
export async function takeRestore(opened: Opened): Promise<boolean> {
  if (!(await readRestore(opened.db))) return false;
  await writeRestore(opened.db, undefined);
  return !!opened.config && !!opened.secret;
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
