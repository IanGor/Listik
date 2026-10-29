#!/usr/bin/env node
/**
 * Listik sync server: a dumb, ordered log of encrypted batches per document,
 * plus the latest encrypted snapshot and the key slot. It never sees a key,
 * a passphrase or any plaintext. Node 20+, no dependencies, files on disk.
 *
 *   LISTIK_DATA      data directory (default ./data)
 *   LISTIK_HOST      bind address (default 127.0.0.1; put TLS in front)
 *   LISTIK_PORT      port (default 8787)
 *   LISTIK_ORIGINS   allowed browser origins, comma-separated, or "*"
 *   LISTIK_RETENTION days to keep batches already folded into a snapshot (default 30)
 *   LISTIK_ALLOW_DELETE "1" lets DELETE remove a document (off otherwise: the app never deletes one)
 *   LISTIK_ALLOW_CREATE "1" accepts new documents; anything else (and unset) refuses them. Set it to create
 *                    yours, then take it away (read per request; with systemd edit sync.env and restart)
 *
 * Failed authentications and probes of unknown documents are rate-limited per address.
 *
 * API (all under /docs/:id, Authorization: Bearer <token>):
 *   PUT    keyslot            create the document (first token wins) or rotate the token
 *   GET    keyslot
 *   GET    ops?after=N        {head, snapshot, batches:[{seq, body}]}; 410 if N is before what is kept
 *   POST   ops                {parent, body}: append after `parent` → 201 {seq}, or 409 {head}
 *   GET    events             stream: "head: N" lines on connect and on every append
 *   PUT    snapshot           X-Seq: the sequence it covers; body: the encrypted snapshot
 *   GET    snapshot           the latest, X-Seq in the header
 *   DELETE                    remove the document (only with LISTIK_ALLOW_DELETE=1)
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';

const DATA = process.env.LISTIK_DATA ?? './data';
const HOST = process.env.LISTIK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.LISTIK_PORT ?? 8787);
const ORIGINS = (process.env.LISTIK_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const RETENTION_MS = Number(process.env.LISTIK_RETENTION ?? 30) * 86_400_000;
const MAX_OPS_BODY = 8 * 1024 * 1024;
const MAX_SNAPSHOT = 256 * 1024 * 1024;
const PAGE = 1000;
/** Failed authentications (or probes of unknown documents) per address before it is told to wait. */
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 10 * 60_000;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const hash = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Writes a file whole or not at all: a temporary file, flushed to the disk,
 * renamed over the old one, and the directory flushed so the rename lasts
 * a power cut. A crash midway leaves the previous version.
 */
async function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  await syncDir(join(path, '..'));
}

async function syncDir(dir) {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Not every platform flushes a directory; the file itself is on disk.
  }
}

/**
 * Appends a line to the log, flushed before the answer goes out; resolves to
 * the file's size before it. A write that fails (a full disk) is cut back to
 * where the file was: half a line left there swallowed the next batch
 * appended after it.
 */
async function appendDurable(path, line) {
  const size = await stat(path).then((s) => s.size, (e) => (e.code === 'ENOENT' ? 0 : Promise.reject(e)));
  try {
    const fh = await open(path, 'a');
    try {
      await fh.write(line);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (e) {
    await truncate(path, size).catch(() => {});
    throw e;
  }
  return size;
}

class HttpError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

/** One document: its files, an in-memory copy of the log, and the clients listening for appends. */
class Document {
  constructor(id) {
    this.id = id;
    this.dir = join(DATA, 'docs', id);
    this.meta = null; // { tokenHash, head, snapshotSeq, created }
    this.ops = new Map(); // seq → { body, t }
    this.oldest = 1; // lowest seq still kept
    this.watchers = new Set();
    this.lock = Promise.resolve();
    this.loading = null;
  }

  /** Runs `fn` after every earlier write to this document. */
  serial(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /** Reads the document from disk once; requests that come meanwhile wait for the same reading. */
  load() {
    if (this.meta) return Promise.resolve(true);
    this.loading ??= this.read().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async read() {
    let meta;
    try {
      meta = JSON.parse(await readFile(join(this.dir, 'meta.json'), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    let text = '';
    try {
      text = await readFile(join(this.dir, 'ops.jsonl'), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    this.ops.clear();
    this.oldest = meta.head + 1;
    // A line cut short by a crash (or one past the head: appended, never
    // acknowledged) is left out and the log written again without it, rather
    // than the whole document refusing to open.
    let dropped = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        dropped++;
        continue;
      }
      if (!Number.isInteger(rec.seq) || rec.seq > meta.head || typeof rec.body !== 'string') {
        dropped++;
        continue;
      }
      this.ops.set(rec.seq, { body: rec.body, t: rec.t });
      if (rec.seq < this.oldest) this.oldest = rec.seq;
    }
    if (dropped) {
      console.error(`listik: ${this.id}: ${dropped} damaged or unacknowledged line(s) left out of the log`);
      await this.rewriteLog();
    }
    // Last: until the log is in, the document is not served.
    this.meta = meta;
    return true;
  }

  async saveMeta() {
    await writeAtomic(join(this.dir, 'meta.json'), JSON.stringify(this.meta));
  }

  /** The log file as the map holds it, in order. */
  async rewriteLog() {
    const lines = [...this.ops].sort((a, b) => a[0] - b[0]).map(([seq, r]) => JSON.stringify({ seq, body: r.body, t: r.t }));
    await writeAtomic(join(this.dir, 'ops.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  }

  async create(tokenHash, keyslot) {
    await mkdir(this.dir, { recursive: true });
    this.meta = { tokenHash, head: 0, snapshotSeq: -1, created: Date.now() };
    await writeAtomic(join(this.dir, 'keyslot.json'), JSON.stringify(keyslot));
    await this.saveMeta();
  }

  authorized(token) {
    if (!this.meta || typeof token !== 'string') return false;
    const a = Buffer.from(hash(token));
    const b = Buffer.from(this.meta.tokenHash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async append(parent, body) {
    return this.serial(async () => {
      if (parent !== this.meta.head) throw new HttpError(409, { head: this.meta.head });
      const seq = this.meta.head + 1;
      const t = Date.now();
      const file = join(this.dir, 'ops.jsonl');
      const size = await appendDurable(file, `${JSON.stringify({ seq, body, t })}\n`);
      this.meta.head = seq;
      try {
        await this.saveMeta();
      } catch (e) {
        // Not taken after all: nobody may see it, or after a restart another batch got its number.
        this.meta.head = seq - 1;
        await truncate(file, size).catch(() => {});
        throw e;
      }
      this.ops.set(seq, { body, t });
      for (const w of this.watchers) w(seq);
      return seq;
    });
  }

  batches(after, limit) {
    const out = [];
    for (let seq = after + 1; seq <= this.meta.head && out.length < limit; seq++) {
      const rec = this.ops.get(seq);
      if (rec) out.push({ seq, body: rec.body });
    }
    return out;
  }

  async putSnapshot(seq, bytes) {
    return this.serial(async () => {
      if (seq > this.meta.head) throw new HttpError(400, 'snapshot ahead of the log');
      if (seq < this.meta.snapshotSeq) return; // an older snapshot: nothing to do
      await writeAtomic(join(this.dir, 'snapshot.bin'), bytes);
      this.meta.snapshotSeq = seq;
      await this.saveMeta();
      await this.retire();
    });
  }

  /** Drops batches the snapshot covers once they are older than the retention period. */
  async retire() {
    const cutoff = Date.now() - RETENTION_MS;
    let drop = this.oldest;
    while (drop <= this.meta.snapshotSeq && (this.ops.get(drop)?.t ?? Infinity) < cutoff) drop++;
    if (drop === this.oldest) return;
    for (let seq = this.oldest; seq < drop; seq++) this.ops.delete(seq);
    this.oldest = drop;
    await this.rewriteLog();
  }

  async destroy() {
    await rm(this.dir, { recursive: true, force: true });
    this.meta = null;
    this.ops.clear();
    for (const w of this.watchers) w(-1);
  }
}

/** address → { count, until }: refused requests, forgotten after the window. */
const failures = new Map();

function throttled(address) {
  const f = failures.get(address);
  if (!f) return false;
  if (Date.now() > f.until) {
    failures.delete(address);
    return false;
  }
  return f.count >= FAIL_LIMIT;
}

function noteFailure(address) {
  const now = Date.now();
  const f = failures.get(address);
  if (f && now <= f.until) f.count++;
  else failures.set(address, { count: 1, until: now + FAIL_WINDOW_MS });
  if (failures.size > 10_000) for (const [k, v] of failures) if (now > v.until) failures.delete(k);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The address failures are counted against. `X-Forwarded-For` is believed
 * only from a proxy on this machine (the TLS proxy in front, DEPLOY.md), and
 * only its last entry, the one the proxy itself added: the first ones are
 * whatever the client sent, and taking them let anyone pick a fresh address
 * per request (or an owner's, to lock them out).
 */
export function addressOf(req) {
  const peer = req.socket.remoteAddress ?? '?';
  const forwarded = req.headers['x-forwarded-for'];
  if (!LOOPBACK.has(peer) || typeof forwarded !== 'string') return peer;
  return forwarded.split(',').map((s) => s.trim()).filter(Boolean).pop() ?? peer;
}

const docs = new Map();
const docFor = (id) => {
  let d = docs.get(id);
  if (!d) docs.set(id, (d = new Document(id)));
  return d;
};

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ORIGINS.includes('*') || ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Seq');
    res.setHeader('Access-Control-Expose-Headers', 'X-Seq, X-Head');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

const token = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true });
  const m = /^\/docs\/([^/]+)(?:\/(keyslot|ops|events|snapshot))?$/.exec(url.pathname);
  if (!m || !ID.test(m[1])) throw new HttpError(404, 'not found');
  const [, id, part] = m;
  const address = addressOf(req);
  if (throttled(address)) throw new HttpError(429, 'too many failed attempts, try later');
  const doc = docFor(id);
  const exists = await doc.load();
  const creating = part === 'keyslot' && req.method === 'PUT';
  // A probe of a document that is not there leaves nothing in memory: random ids no longer pile up.
  if (!exists && !creating && docs.get(id) === doc && !doc.meta && !doc.watchers.size) docs.delete(id);
  const refuse = (status, message) => {
    noteFailure(address);
    throw new HttpError(status, message);
  };

  if (part === 'keyslot' && req.method === 'PUT') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    if (!body.keyslot || typeof body.keyslot !== 'object') throw new HttpError(400, 'keyslot missing');
    if (!exists) {
      if (process.env.LISTIK_ALLOW_CREATE !== '1') refuse(403, 'this server does not accept new documents');
      const t = body.token ?? token(req);
      if (typeof t !== 'string' || t.length < 16) throw new HttpError(400, 'token missing');
      // Two creations of one id at once: the first one wins, the second is told (it used to overwrite the token).
      await doc.serial(async () => {
        if (doc.meta) throw new HttpError(409, 'the document exists');
        await doc.create(hash(t), body.keyslot);
      });
      docs.set(id, doc);
      return json(res, 201, { created: true });
    }
    if (!doc.authorized(token(req))) refuse(401, 'unauthorized');
    await doc.serial(async () => {
      await writeAtomic(join(doc.dir, 'keyslot.json'), JSON.stringify(body.keyslot));
      if (typeof body.newToken === 'string' && body.newToken.length >= 16) {
        doc.meta.tokenHash = hash(body.newToken);
        await doc.saveMeta();
      }
    });
    return json(res, 200, { updated: true });
  }

  if (!exists) refuse(404, 'no such document');
  if (!doc.authorized(token(req))) refuse(401, 'unauthorized');

  if (part === 'keyslot' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(await readFile(join(doc.dir, 'keyslot.json')));
  }
  if (part === 'ops' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Math.min(PAGE, Number(url.searchParams.get('limit') ?? PAGE));
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'bad after');
    const snapshot = doc.meta.snapshotSeq >= 0 ? { seq: doc.meta.snapshotSeq } : null;
    if (after + 1 < doc.oldest && after < doc.meta.head) throw new HttpError(410, { head: doc.meta.head, snapshot });
    return json(res, 200, { head: doc.meta.head, snapshot, batches: doc.batches(after, limit) });
  }
  if (part === 'ops' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, MAX_OPS_BODY)).toString('utf8'));
    if (!Number.isInteger(body.parent) || typeof body.body !== 'string' || !body.body) throw new HttpError(400, 'parent and body required');
    const seq = await doc.append(body.parent, body.body);
    return json(res, 201, { seq });
  }
  if (part === 'events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.write(`head: ${doc.meta.head}\n`);
    const watcher = (seq) => res.write(seq < 0 ? 'gone\n' : `head: ${seq}\n`);
    doc.watchers.add(watcher);
    const beat = setInterval(() => res.write('\n'), 25_000);
    req.on('close', () => {
      doc.watchers.delete(watcher);
      clearInterval(beat);
    });
    return;
  }
  if (part === 'snapshot' && req.method === 'PUT') {
    const seq = Number(req.headers['x-seq']);
    if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'X-Seq required');
    await doc.putSnapshot(seq, await readBody(req, MAX_SNAPSHOT));
    return json(res, 200, { seq: doc.meta.snapshotSeq });
  }
  if (part === 'snapshot' && req.method === 'GET') {
    if (doc.meta.snapshotSeq < 0) throw new HttpError(404, 'no snapshot');
    const bytes = await readFile(join(doc.dir, 'snapshot.bin'));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Seq': String(doc.meta.snapshotSeq), 'X-Head': String(doc.meta.head), 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  if (!part && req.method === 'DELETE') {
    // The app never deletes a document; a stolen token (or a device key used by a script on the app's origin) must not wipe it.
    if (process.env.LISTIK_ALLOW_DELETE !== '1') throw new HttpError(403, 'deleting documents is turned off on this server');
    await doc.destroy();
    docs.delete(id);
    return json(res, 200, { deleted: true });
  }
  throw new HttpError(404, 'not found');
}

export function createListikServer() {
  return createServer((req, res) => {
    cors(req, res);
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) {
        if (typeof e.body === 'string') json(res, e.status, { error: e.body });
        else json(res, e.status, e.body);
      } else {
        console.error(e);
        json(res, 500, { error: 'internal error' });
      }
    });
  });
}

/** How many documents are held in memory (for tests). */
export const openDocuments = () => docs.size;

/** Loads every document directory, so `events` and `oldest` are right from the first request. */
export async function warmUp() {
  await mkdir(join(DATA, 'docs'), { recursive: true });
  for (const id of await readdir(join(DATA, 'docs'))) {
    try {
      if (ID.test(id) && (await stat(join(DATA, 'docs', id))).isDirectory()) await docFor(id).load();
    } catch (e) {
      // One damaged document must not keep the server, and every other document, down.
      console.error(`listik: ${id} did not load`, e);
      docs.delete(id);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await warmUp();
  createListikServer().listen(PORT, HOST, () => console.log(`listik sync on http://${HOST}:${PORT}, data in ${DATA}`));
}
