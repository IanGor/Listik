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
 *
 * API (all under /docs/:id, Authorization: Bearer <token>):
 *   PUT    keyslot            create the document (first token wins) or rotate the token
 *   GET    keyslot
 *   GET    ops?after=N        {head, snapshot, batches:[{seq, body}]}; 410 if N is before what is kept
 *   POST   ops                {parent, body}: append after `parent` → 201 {seq}, or 409 {head}
 *   GET    events             stream: "head: N" lines on connect and on every append
 *   PUT    snapshot           X-Seq: the sequence it covers; body: the encrypted snapshot
 *   GET    snapshot           the latest, X-Seq in the header
 *   DELETE                    remove the document
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATA = process.env.LISTIK_DATA ?? './data';
const HOST = process.env.LISTIK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.LISTIK_PORT ?? 8787);
const ORIGINS = (process.env.LISTIK_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const RETENTION_MS = Number(process.env.LISTIK_RETENTION ?? 30) * 86_400_000;
const MAX_OPS_BODY = 8 * 1024 * 1024;
const MAX_SNAPSHOT = 256 * 1024 * 1024;
const PAGE = 1000;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const hash = (s) => createHash('sha256').update(s).digest('hex');

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
  }

  /** Runs `fn` after every earlier write to this document. */
  serial(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async load() {
    if (this.meta) return true;
    try {
      this.meta = JSON.parse(await readFile(join(this.dir, 'meta.json'), 'utf8'));
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
    this.oldest = this.meta.head + 1;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const { seq, body, t } = JSON.parse(line);
      this.ops.set(seq, { body, t });
      if (seq < this.oldest) this.oldest = seq;
    }
    return true;
  }

  async saveMeta() {
    const tmp = join(this.dir, 'meta.json.tmp');
    await writeFile(tmp, JSON.stringify(this.meta));
    await rename(tmp, join(this.dir, 'meta.json'));
  }

  async create(tokenHash, keyslot) {
    await mkdir(this.dir, { recursive: true });
    this.meta = { tokenHash, head: 0, snapshotSeq: -1, created: Date.now() };
    await writeFile(join(this.dir, 'keyslot.json'), JSON.stringify(keyslot));
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
      await appendFile(join(this.dir, 'ops.jsonl'), `${JSON.stringify({ seq, body, t })}\n`);
      this.ops.set(seq, { body, t });
      this.meta.head = seq;
      await this.saveMeta();
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
      const tmp = join(this.dir, 'snapshot.bin.tmp');
      await writeFile(tmp, bytes);
      await rename(tmp, join(this.dir, 'snapshot.bin'));
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
    const lines = [...this.ops].sort((a, b) => a[0] - b[0]).map(([seq, r]) => JSON.stringify({ seq, body: r.body, t: r.t }));
    const tmp = join(this.dir, 'ops.jsonl.tmp');
    await writeFile(tmp, lines.length ? `${lines.join('\n')}\n` : '');
    await rename(tmp, join(this.dir, 'ops.jsonl'));
  }

  async destroy() {
    await rm(this.dir, { recursive: true, force: true });
    this.meta = null;
    this.ops.clear();
    for (const w of this.watchers) w(-1);
  }
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
  const doc = docFor(id);
  const exists = await doc.load();

  if (part === 'keyslot' && req.method === 'PUT') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    if (!body.keyslot || typeof body.keyslot !== 'object') throw new HttpError(400, 'keyslot missing');
    if (!exists) {
      const t = body.token ?? token(req);
      if (typeof t !== 'string' || t.length < 16) throw new HttpError(400, 'token missing');
      await doc.create(hash(t), body.keyslot);
      return json(res, 201, { created: true });
    }
    if (!doc.authorized(token(req))) throw new HttpError(401, 'unauthorized');
    await doc.serial(async () => {
      await writeFile(join(doc.dir, 'keyslot.json'), JSON.stringify(body.keyslot));
      if (typeof body.newToken === 'string' && body.newToken.length >= 16) {
        doc.meta.tokenHash = hash(body.newToken);
        await doc.saveMeta();
      }
    });
    return json(res, 200, { updated: true });
  }

  if (!exists) throw new HttpError(404, 'no such document');
  if (!doc.authorized(token(req))) throw new HttpError(401, 'unauthorized');

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

/** Loads every document directory, so `events` and `oldest` are right from the first request. */
export async function warmUp() {
  await mkdir(join(DATA, 'docs'), { recursive: true });
  for (const id of await readdir(join(DATA, 'docs'))) {
    if (ID.test(id) && (await stat(join(DATA, 'docs', id))).isDirectory()) await docFor(id).load();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await warmUp();
  createListikServer().listen(PORT, HOST, () => console.log(`listik sync on http://${HOST}:${PORT}, data in ${DATA}`));
}
