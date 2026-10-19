import type { Op } from '../model/types';
import { decryptWith, encryptWith, isEncrypted, type Encrypted } from '../sync/crypto';
import { fromUtf8, utf8 } from '../sync/encoding';

/**
 * How records are stored in IndexedDB. Plain records are the snapshot JSON
 * string and `Op[]` batches, as before encryption existed. The encrypted
 * codec writes AES-GCM records and reads both kinds, so turning encryption
 * on needs no rewrite up front: the next compaction folds everything into
 * an encrypted snapshot. The plain codec refuses encrypted records
 * (`LockedError`): the document needs its key first.
 */
export interface Codec {
  readonly encrypted: boolean;
  /** The data key, for handing to the compaction worker. */
  readonly key?: CryptoKey;
  /** Set while recoding: the codec being replaced, which reads what it stored (see `recoding`). */
  readonly old?: { key?: CryptoKey };
  encodeSnapshot(json: string): Promise<unknown>;
  decodeSnapshot(record: unknown): Promise<string>;
  encodeBatch(ops: Op[]): Promise<unknown>;
  decodeBatch(record: unknown): Promise<Op[]>;
}

export class LockedError extends Error {
  constructor() {
    super('The document is encrypted and needs its key');
    this.name = 'LockedError';
  }
}

const SNAPSHOT = 'listik|local|snapshot';
const OPS = 'listik|local|ops';

export const plainCodec: Codec = {
  encrypted: false,
  async encodeSnapshot(json) { return json; },
  async decodeSnapshot(record) {
    if (isEncrypted(record)) throw new LockedError();
    return record as string;
  },
  async encodeBatch(ops) { return ops; },
  async decodeBatch(record) {
    if (isEncrypted(record)) throw new LockedError();
    return record as Op[];
  },
};

/**
 * Writes like `codec` and reads what either `codec` or `old` stored. A
 * recode compacts through it, so the snapshot and batches stored the old
 * way and the batches written since the switch all fold into a snapshot of
 * the new kind. Without it a switch between two keys (or from a key back to
 * plain) cannot read the old records and leaves them stranded.
 */
export function recoding(codec: Codec, old: Codec): Codec {
  const either = <T>(first: () => Promise<T>, second: () => Promise<T>) =>
    first().catch((e: unknown) => second().catch(() => { throw e; }));
  return {
    ...codec,
    old: { key: old.key },
    decodeSnapshot: (record) => either(() => codec.decodeSnapshot(record), () => old.decodeSnapshot(record)),
    decodeBatch: (record) => either(() => codec.decodeBatch(record), () => old.decodeBatch(record)),
  };
}

/** The codec for a data key, or the plain one without. */
export const codecForKey = (key?: CryptoKey): Codec => (key ? encryptedCodec(key) : plainCodec);

export function encryptedCodec(key: CryptoKey): Codec {
  return {
    encrypted: true,
    key,
    encodeSnapshot: (json) => encryptWith(key, utf8(json), SNAPSHOT),
    async decodeSnapshot(record) {
      return isEncrypted(record) ? fromUtf8(await decryptWith(key, record as Encrypted, SNAPSHOT)) : (record as string);
    },
    encodeBatch: (ops) => encryptWith(key, utf8(JSON.stringify(ops)), OPS),
    async decodeBatch(record) {
      return isEncrypted(record) ? (JSON.parse(fromUtf8(await decryptWith(key, record as Encrypted, OPS))) as Op[]) : (record as Op[]);
    },
  };
}
