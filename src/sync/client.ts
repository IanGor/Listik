import type { Keyslot } from './crypto';

/** The server's answer to `GET ops`. */
export interface OpsPage {
  head: number;
  snapshot: { seq: number } | null;
  batches: { seq: number; body: string }[];
}

/** `after` is older than what the server still keeps: start again from its snapshot. */
export class GoneError extends Error {
  head: number;
  snapshot: { seq: number } | null;
  constructor(head: number, snapshot: { seq: number } | null) {
    super('log truncated on the server');
    this.name = 'GoneError';
    this.head = head;
    this.snapshot = snapshot;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** The sync server's API for one document (server/index.js). */
export interface Transport {
  getKeyslot(): Promise<Keyslot>;
  /** Creates the document when it does not exist yet (the token then becomes its token). */
  putKeyslot(keyslot: Keyslot, newToken?: string): Promise<{ created: boolean }>;
  getOps(after: number): Promise<OpsPage>;
  /** Appends after `parent`; `conflict` carries the server's head when someone else appended first. */
  postOps(parent: number, body: string): Promise<{ seq: number } | { conflict: number }>;
  getSnapshot(): Promise<{ seq: number; head: number; bytes: Uint8Array } | null>;
  putSnapshot(seq: number, bytes: Uint8Array): Promise<void>;
  /** Streams the server's head until `signal` aborts or the connection drops. */
  events(onHead: (head: number) => void, signal: AbortSignal): Promise<void>;
  delete(): Promise<void>;
}

export const normalizeServer = (url: string): string => url.trim().replace(/\/+$/, '');

export function httpTransport(server: string, docId: string, token: string, fetchFn: typeof fetch = fetch): Transport {
  const base = `${normalizeServer(server)}/docs/${encodeURIComponent(docId)}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function call(path: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    const res = await fetchFn(base + path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    if (res.ok || okStatuses.includes(res.status)) return res;
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // No JSON body.
    }
    if (res.status === 410) {
      const body = (await fetchFn(base + path, { headers: auth }).then((r) => r.json())) as { head: number; snapshot: { seq: number } | null };
      throw new GoneError(body.head, body.snapshot);
    }
    throw new HttpError(res.status, message);
  }

  return {
    async getKeyslot() {
      return (await call('/keyslot')).json() as Promise<Keyslot>;
    },
    async putKeyslot(keyslot, newToken) {
      const res = await call('/keyslot', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyslot, token, newToken }),
      });
      return { created: res.status === 201 };
    },
    async getOps(after) {
      const res = await fetchFn(`${base}/ops?after=${after}`, { headers: auth });
      if (res.status === 410) {
        const body = (await res.json()) as { head: number; snapshot: { seq: number } | null };
        throw new GoneError(body.head, body.snapshot);
      }
      if (!res.ok) throw new HttpError(res.status, `ops: ${res.status}`);
      return res.json() as Promise<OpsPage>;
    },
    async postOps(parent, body) {
      const res = await call('/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent, body }),
      }, [409]);
      if (res.status === 409) return { conflict: ((await res.json()) as { head: number }).head };
      return res.json() as Promise<{ seq: number }>;
    },
    async getSnapshot() {
      const res = await call('/snapshot', {}, [404]);
      if (res.status === 404) return null;
      return {
        seq: Number(res.headers.get('X-Seq')),
        head: Number(res.headers.get('X-Head')),
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async putSnapshot(seq, bytes) {
      await call('/snapshot', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Seq': String(seq) }, body: bytes as BodyInit });
    },
    async events(onHead, signal) {
      const res = await fetchFn(`${base}/events`, { headers: auth, signal });
      if (!res.ok || !res.body) throw new HttpError(res.status, `events: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;
        for (const line of lines) {
          const m = /^head: (\d+)$/.exec(line);
          if (m) onHead(Number(m[1]));
        }
      }
    },
    async delete() {
      await call('', { method: 'DELETE' });
    },
  };
}
