import { describe, expect, it } from 'vitest';
import {
  createKeyslot, dataKey, decryptWith, deviceKey, encryptWith, isEncrypted, newDocId, openForDevice, openKeyslot, rewrapKeyslot, sealForDevice,
} from '../src/sync/crypto';
import { fromBase64, fromUtf8, gunzip, gzip, sha256, toBase64, utf8 } from '../src/sync/encoding';

describe('encoding', () => {
  it('round-trips base64 and gzip, hashes deterministically', async () => {
    const b = utf8('Война и мир '.repeat(1000));
    expect(fromBase64(toBase64(b))).toEqual(b);
    const z = await gzip(b);
    expect(z.length).toBeLessThan(b.length / 10);
    expect(fromUtf8(await gunzip(z))).toBe('Война и мир '.repeat(1000));
    expect(await sha256(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('keys', () => {
  it('a key slot opens with the right passphrase only, and the token follows the passphrase', { timeout: 60_000 }, async () => {
    const docId = newDocId();
    const { keyslot, dek, token } = await createKeyslot('верный пароль', docId);
    const opened = await openKeyslot('верный пароль', docId, keyslot);
    expect(opened.dek).toEqual(dek);
    expect(opened.token).toBe(token);
    await expect(openKeyslot('другой пароль', docId, keyslot)).rejects.toThrow();
    const re = await rewrapKeyslot('новый пароль', docId, dek);
    expect(re.token).not.toBe(token);
    expect((await openKeyslot('новый пароль', docId, re.keyslot)).dek).toEqual(dek);
  });

  it('records are bound to their context and the device key seals the secret', { timeout: 60_000 }, async () => {
    const key = await dataKey(utf8('0123456789abcdef0123456789abcdef'));
    const rec = await encryptWith(key, utf8('тайна'), 'listik|doc|ops|7');
    expect(isEncrypted(rec)).toBe(true);
    expect(fromUtf8(await decryptWith(key, rec, 'listik|doc|ops|7'))).toBe('тайна');
    await expect(decryptWith(key, rec, 'listik|doc|ops|8')).rejects.toThrow();
    const dk = await deviceKey();
    const sealed = await sealForDevice(dk, { dek: utf8('k'.repeat(32)), token: 't' });
    expect(await openForDevice(dk, sealed)).toEqual({ dek: utf8('k'.repeat(32)), token: 't' });
  });
});
