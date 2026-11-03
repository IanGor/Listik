import { done, request } from './db';

export interface UsageEvent {
  schema: 1;
  time: number;
  session: string;
  device: string;
  platform: 'phone' | 'tablet' | 'laptop';
  os: string;
  width: number;
  height: number;
  action: string;
  input: string;
  softwareKeyboard: boolean;
}

export function devicePlatform(width: number, height: number, touch: boolean, mobile: boolean): UsageEvent['platform'] {
  if (!mobile) return 'laptop';
  if (touch && Math.min(width, height) >= 700) return 'tablet';
  return mobile || (touch && Math.min(width, height) < 700) ? 'phone' : 'laptop';
}

const LIMIT = 50_000;
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('listik-usage', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('events', { autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { database = undefined; reject(r.error); };
  });
}

export async function appendUsage(events: UsageEvent[]) {
  const connection = await db();
  const tx = connection.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  for (const event of events) store.add(event);
  const count = await request(store.count());
  if (count > LIMIT) {
    let left = count - LIMIT;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row || left-- <= 0) return;
      row.delete();
      row.continue();
    };
  }
  await done(tx);
}

export async function usageEvents(): Promise<UsageEvent[]> {
  const connection = await db();
  return request(connection.transaction('events').objectStore('events').getAll());
}
