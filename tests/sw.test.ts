import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The service worker (public/sw.js), run in a sandbox with a fake `self`,
 * `caches` and `fetch`: what a page load leaves in the cache for offline.
 */
async function worker(answer: () => Promise<Response>) {
  const stored = new Map<string, Response>();
  const handlers = new Map<string, (event: unknown) => void>();
  const cache = {
    put: async (key: string | Request, response: Response) => void stored.set(typeof key === 'string' ? key : key.url, response),
    addAll: async () => {},
  };
  const sandbox = {
    self: {
      location: { origin: 'https://app.example' },
      addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
      skipWaiting: () => {},
      clients: { claim: async () => {} },
    },
    caches: { open: async () => cache, match: async (key: string) => stored.get(key), keys: async () => [], delete: async () => true },
    fetch: answer,
    URL,
  };
  runInNewContext(await readFile('public/sw.js', 'utf8'), sandbox);
  /** A page load: the response the page gets. */
  const navigate = async (): Promise<Response | undefined> => {
    let responded: Promise<Response | undefined> | undefined;
    handlers.get('fetch')!({ request: { method: 'GET', url: 'https://app.example/', mode: 'navigate' }, respondWith: (p: Promise<Response | undefined>) => (responded = p) });
    const response = await responded;
    await new Promise((resolve) => setTimeout(resolve, 0)); // the cache write runs after the answer
    return response;
  };
  return { stored, navigate };
}

/** A response as the page's fetch sees it (`type` and `redirected` are read-only on a real one). */
function page(body: string, init: { status?: number } = {}, extra: { type?: string; redirected?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const make = (): Response => ({
    ok: status >= 200 && status < 300, status, type: extra.type ?? 'basic', redirected: extra.redirected ?? false,
    clone: make, text: async () => body,
  }) as unknown as Response;
  return make();
}

describe('service worker', () => {
  it('keeps the app\'s own page for offline', async () => {
    const { stored, navigate } = await worker(async () => page('<app>'));
    await navigate();
    expect(await stored.get('./')?.text()).toBe('<app>');
  });

  it('does not keep an error page or a redirect (a Wi-Fi login page) as the app: the last good one stays', async () => {
    let next = page('<app>');
    const { stored, navigate } = await worker(async () => next);
    await navigate();
    for (const bad of [page('not found', { status: 404 }), page('<login>', {}, { redirected: true }), page('<other>', {}, { type: 'opaqueredirect' })]) {
      next = bad;
      expect(await navigate()).toBe(bad); // shown as it is, online
      expect(await stored.get('./')?.text()).toBe('<app>');
    }
  });
});
