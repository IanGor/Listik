import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The sync server's files across a crash: each test "restarts" it by
 * loading the module afresh (an empty memory) over the same data directory.
 */

let dataDir: string;
let server: Server | null = null;
let url = '';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'listik-server-'));
  process.env.LISTIK_DATA = dataDir;
  process.env.LISTIK_RETENTION = '30';
  process.env.LISTIK_ALLOW_CREATE = '1';
});

afterEach(() => stop());

async function start(warm = true): Promise<void> {
  vi.resetModules();
  const mod = (await import('../server/index.js')) as { createListikServer(): Server; warmUp(): Promise<void> };
  if (warm) await mod.warmUp();
  server = mod.createListikServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function stop(): Promise<void> {
  const s = server;
  server = null;
  return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
}

let n = 0;
const newId = () => `server-test-${n++}-${Date.now()}`;

async function call(id: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${url}/docs/${id}${path}`, { ...init, headers: { Authorization: `Bearer token-of-${id}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
}

async function create(id: string, batches: number): Promise<void> {
  expect((await call(id, '/keyslot', { method: 'PUT', body: JSON.stringify({ keyslot: { v: 1 } }) })).status).toBe(201);
  for (let k = 0; k < batches; k++) {
    expect((await call(id, '/ops', { method: 'POST', body: JSON.stringify({ parent: k, body: `batch-${k + 1}` }) })).status).toBe(201);
  }
}

const log = (id: string) => readFile(join(dataDir, 'docs', id, 'ops.jsonl'), 'utf8');
const ops = async (id: string) => (await call(id, '/ops?after=0')).json() as Promise<{ head: number; batches: { seq: number; body: string }[] }>;

describe('the sync server after a crash', () => {
  it('a log line cut short is left out: the document opens, keeps what was acknowledged and takes the next batch', async () => {
    await start();
    const id = newId();
    await create(id, 2);
    await stop();
    await appendFile(join(dataDir, 'docs', id, 'ops.jsonl'), '{"seq":3,"bo');
    await start();
    const page = await ops(id);
    expect(page.head).toBe(2);
    expect(page.batches.map((b) => b.body)).toEqual(['batch-1', 'batch-2']);
    expect((await call(id, '/ops', { method: 'POST', body: JSON.stringify({ parent: 2, body: 'batch-3' }) })).status).toBe(201);
    expect((await log(id)).trim().split('\n').map((l) => JSON.parse(l).body)).toEqual(['batch-1', 'batch-2', 'batch-3']);
  });

  it('a line past the head (appended, never acknowledged) is not served, and its number goes to the next batch', async () => {
    await start();
    const id = newId();
    await create(id, 1);
    await stop();
    await appendFile(join(dataDir, 'docs', id, 'ops.jsonl'), `${JSON.stringify({ seq: 2, body: 'never acknowledged', t: 0 })}\n`);
    await start();
    expect((await ops(id)).batches.map((b) => b.body)).toEqual(['batch-1']);
    expect(await (await call(id, '/ops', { method: 'POST', body: JSON.stringify({ parent: 1, body: 'batch-2' }) })).json()).toEqual({ seq: 2 });
    expect((await ops(id)).batches.map((b) => b.body)).toEqual(['batch-1', 'batch-2']);
  });

  it('one document that does not load keeps neither the server nor the other documents down', async () => {
    await start();
    const good = newId();
    const bad = newId();
    await create(good, 1);
    await create(bad, 1);
    await stop();
    await writeFile(join(dataDir, 'docs', bad, 'meta.json'), '{"tokenHash":');
    await start();
    expect((await ops(good)).batches.map((b) => b.body)).toEqual(['batch-1']);
    expect((await call(bad, '/ops?after=0')).status).toBe(500);
  });

  it('requests that come while a document is being read wait for the whole of it', async () => {
    await start();
    const id = newId();
    await create(id, 3);
    await stop();
    await start(false); // nothing read yet: the first requests read it
    const pages = await Promise.all([ops(id), ops(id), ops(id)]);
    for (const page of pages) expect(page.batches.map((b) => b.seq)).toEqual([1, 2, 3]);
  });
});

describe('the address failed attempts count against', () => {
  const req = (peer: string, forwarded?: string) => ({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } });

  it('is the last X-Forwarded-For entry from a proxy on this machine, the peer otherwise', async () => {
    vi.resetModules();
    const { addressOf } = await import('../server/index.js');
    expect(addressOf(req('127.0.0.1', '203.0.113.7'))).toBe('203.0.113.7');
    expect(addressOf(req('::1', 'spoofed, 203.0.113.7'))).toBe('203.0.113.7'); // the client's own entries come first
    expect(addressOf(req('127.0.0.1'))).toBe('127.0.0.1');
    expect(addressOf(req('198.51.100.2', '203.0.113.7'))).toBe('198.51.100.2'); // not through the proxy: the header is the client's
  });

  it('a client inventing a first entry per request is still throttled', async () => {
    await start();
    const id = newId();
    await create(id, 0);
    let last = 0;
    for (let k = 0; k < 22; k++) {
      const res = await fetch(`${url}/docs/${id}/ops?after=0`, { headers: { Authorization: 'Bearer wrong-token', 'X-Forwarded-For': `10.0.0.${k}, 203.0.113.9` } });
      last = res.status;
    }
    expect(last).toBe(429);
    // Another client behind the proxy is not.
    expect((await fetch(`${url}/docs/${id}/ops?after=0`, { headers: { Authorization: `Bearer token-of-${id}`, 'X-Forwarded-For': '203.0.113.10' } })).status).toBe(200);
  });
});

describe('documents that are not there', () => {
  it('a probe of a random id leaves nothing in memory, and two creations of one id at once: the first wins', async () => {
    vi.resetModules();
    const mod = (await import('../server/index.js')) as { createListikServer(): Server; warmUp(): Promise<void>; openDocuments(): number };
    await mod.warmUp();
    server = mod.createListikServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const before = mod.openDocuments();
    for (let k = 0; k < 5; k++) expect((await call(newId(), '/ops?after=0')).status).toBe(404);
    expect(mod.openDocuments()).toBe(before);
    const id = newId();
    const put = (token: string) => fetch(`${url}/docs/${id}/keyslot`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyslot: { v: 1 }, token }) });
    const statuses = (await Promise.all([put('first-token-0123456789'), put('second-token-0123456789')])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(mod.openDocuments()).toBe(before + 1);
  });
});
