import { argon2id } from 'hash-wasm';
import { fromBase64, fromUtf8, randomBytes, toBase64, utf8 } from './encoding';

/**
 * End-to-end encryption of the document. The server (and the local
 * IndexedDB) only ever hold ciphertext.
 *
 * Keys:
 * - the passphrase and the document code (a random id that doubles as the
 *   Argon2id salt) give the *key-encryption key* (KEK). Nothing leaves the
 *   device for this step, so a new device can start from code + passphrase;
 * - the KEK wraps a random *document key* (DEK) in the key slot stored on
 *   the server. Changing the passphrase re-wraps the DEK: nothing is
 *   re-encrypted;
 * - the KEK also gives the *auth token* the server checks. The server learns
 *   the token, never the passphrase or any key, so a compromised server can
 *   withhold or tamper (which the hash chain detects) but not read;
 * - the DEK gives the AES-256-GCM *data key* for every record.
 */

/** Argon2id cost: 64 MiB, 3 passes. About a second on a phone, once per unlock. */
const KDF = { m: 65536, t: 3, p: 1 };

export interface Encrypted {
  /** Format marker, so plaintext legacy records are told apart. */
  enc: 1;
  iv: Uint8Array;
  ct: Uint8Array;
}

export const isEncrypted = (x: unknown): x is Encrypted =>
  typeof x === 'object' && x !== null && (x as Encrypted).enc === 1 && (x as Encrypted).iv instanceof Uint8Array;

/** The key slot: the document key wrapped by the passphrase-derived key. Stored on the server and locally. */
export interface Keyslot {
  v: 1;
  kdf: typeof KDF;
  wrapped: { iv: string; ct: string };
}

export interface DocKeys {
  /** For encrypting records; shared by the page and the compaction worker. */
  data: CryptoKey;
  /** Bearer token for the server. */
  token: string;
}

async function importAes(raw: Uint8Array, usages: KeyUsage[] = ['encrypt', 'decrypt']): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, usages);
}

async function hkdf(secret: Uint8Array, info: string, bytes = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(info) }, key, bytes * 8);
  return new Uint8Array(bits);
}

/** The passphrase-derived key for a document: slow by design. */
export async function deriveKek(passphrase: string, docId: string, kdf = KDF): Promise<Uint8Array> {
  return argon2id({
    password: passphrase.normalize('NFKC'),
    salt: utf8(`listik|${docId}`),
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
}

export const tokenFromKek = async (kek: Uint8Array): Promise<string> => toBase64(await hkdf(kek, 'listik/auth'));

export async function encryptWith(key: CryptoKey, plain: Uint8Array, aad: string): Promise<Encrypted> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(aad) }, key, plain as BufferSource);
  return { enc: 1, iv, ct: new Uint8Array(ct) };
}

export async function decryptWith(key: CryptoKey, rec: Encrypted, aad: string): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv as BufferSource, additionalData: utf8(aad) }, key, rec.ct as BufferSource);
  return new Uint8Array(plain);
}

/** A new document key, wrapped for `passphrase`. */
export async function createKeyslot(passphrase: string, docId: string): Promise<{ keyslot: Keyslot; dek: Uint8Array; token: string }> {
  const kek = await deriveKek(passphrase, docId);
  const dek = randomBytes(32);
  return { keyslot: await wrapDek(kek, dek), dek, token: await tokenFromKek(kek) };
}

async function wrapDek(kek: Uint8Array, dek: Uint8Array): Promise<Keyslot> {
  const w = await encryptWith(await importAes(kek), dek, 'listik|keyslot');
  return { v: 1, kdf: KDF, wrapped: { iv: toBase64(w.iv), ct: toBase64(w.ct) } };
}

/**
 * The Argon2id cost a key slot may ask for. It comes from the server: one
 * asking for gigabytes, or for thousands of passes, hung or crashed the
 * page before any check of the passphrase. A smaller cost than ours only
 * gives a key that does not open the slot.
 */
const KDF_LIMITS = { m: [8, 1 << 20], t: [1, 16], p: [1, 8] } as const;

function checkKdf(kdf: unknown): asserts kdf is typeof KDF {
  const k = kdf as Record<string, unknown> | null;
  const ok = !!k && (Object.keys(KDF_LIMITS) as (keyof typeof KDF_LIMITS)[]).every((key) => {
    const v = k[key];
    return Number.isInteger(v) && (v as number) >= KDF_LIMITS[key][0] && (v as number) <= KDF_LIMITS[key][1];
  });
  if (!ok) throw new Error('Слот ключа с сервера просит недопустимые параметры: документ не открыт');
}

/** Unwraps the document key; throws if the passphrase is wrong. */
export async function openKeyslot(passphrase: string, docId: string, keyslot: Keyslot): Promise<{ dek: Uint8Array; token: string }> {
  checkKdf(keyslot.kdf);
  const kek = await deriveKek(passphrase, docId, keyslot.kdf);
  const dek = await decryptWith(await importAes(kek), { enc: 1, iv: fromBase64(keyslot.wrapped.iv), ct: fromBase64(keyslot.wrapped.ct) }, 'listik|keyslot');
  return { dek, token: await tokenFromKek(kek) };
}

/** The same document key wrapped for a new passphrase (and the new token that goes with it). */
export async function rewrapKeyslot(passphrase: string, docId: string, dek: Uint8Array): Promise<{ keyslot: Keyslot; token: string }> {
  const kek = await deriveKek(passphrase, docId);
  return { keyslot: await wrapDek(kek, dek), token: await tokenFromKek(kek) };
}

export async function dataKey(dek: Uint8Array): Promise<CryptoKey> {
  return importAes(await hkdf(dek, 'listik/data'));
}

/**
 * "Remember on this device": a key that never leaves this browser (not
 * extractable, kept in IndexedDB) wraps the document key and token, so the
 * passphrase is asked once. It protects the data at rest on the device, not
 * against code running in this page.
 */
export async function deviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealForDevice(key: CryptoKey, secret: { dek: Uint8Array; token: string }): Promise<Encrypted> {
  return encryptWith(key, utf8(JSON.stringify({ dek: toBase64(secret.dek), token: secret.token })), 'listik|device');
}

export async function openForDevice(key: CryptoKey, rec: Encrypted): Promise<{ dek: Uint8Array; token: string }> {
  const s = JSON.parse(fromUtf8(await decryptWith(key, rec, 'listik|device'))) as { dek: string; token: string };
  return { dek: fromBase64(s.dek), token: s.token };
}

/** A new document code: random, and the Argon2id salt for its passphrase. */
export const newDocId = (): string => toBase64(randomBytes(15)).replace(/\+/g, '-').replace(/\//g, '_');
