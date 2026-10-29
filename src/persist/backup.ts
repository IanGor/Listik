import type { Doc, DocListener } from '../model/doc';
import { toMarkdown } from '../model/outline-text';
import { done, openDb, request } from './db';

export type BackupState = 'unsupported' | 'off' | 'on' | 'paused' | 'error';

export interface BackupStatus {
  state: BackupState;
  /** The folder's name. */
  folder?: string;
  /** When the last copy was written. */
  last?: number;
  error?: string;
}

/** The part of the File System Access API backups use; tests pass a fake. */
export interface Folder {
  name: string;
  getFileHandle(name: string, options: { create: true }): Promise<{
    createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

/** Stored in the document's `meta` store, next to the snapshot. */
const KEY = 'backupDir';
/** A changed document is copied at most this often, and when the tab is hidden. */
const INTERVAL = 5 * 60_000;

export const backupSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const pad = (n: number) => String(n).padStart(2, '0');

/** `listik-2026-10-17.md`: one file per day, rewritten through the day, so the folder keeps a day-by-day history. */
export function backupName(time: number): string {
  const d = new Date(time);
  return `listik-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
}

/**
 * Automatic copies of the document, as Markdown, into a folder on disk the
 * user picks (Chromium's File System Access API). The data otherwise lives
 * only in this browser's IndexedDB, which can be cleared.
 */
export class Backup implements DocListener {
  status: BackupStatus = { state: backupSupported() ? 'off' : 'unsupported' };
  private folder: Folder | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(s: BackupStatus) => void>();
  private db: IDBDatabase;
  private doc: Doc;
  private now: () => number;

  private constructor(db: IDBDatabase, doc: Doc, now: () => number) {
    this.db = db;
    this.doc = doc;
    this.now = now;
    doc.subscribe(this);
  }

  /**
   * Restores the folder picked earlier. After a reload the browser usually
   * asks again before writing: the state is then `paused` until `resume`.
   */
  static async open(name: string, doc: Doc, now = () => Date.now()): Promise<Backup> {
    const db = await openDb(name);
    const backup = new Backup(db, doc, now);
    const folder = (await request(db.transaction('meta').objectStore('meta').get(KEY))) as Folder | undefined;
    if (folder) {
      backup.folder = folder;
      const permission = (await folder.queryPermission?.({ mode: 'readwrite' })) ?? 'granted';
      backup.set({ state: permission === 'granted' ? 'on' : 'paused', folder: folder.name });
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void backup.writeIfDirty();
      });
    }
    return backup;
  }

  subscribe(fn: (s: BackupStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Picks a folder (needs a user gesture) and writes the first copy right away. */
  async choose(folder?: Folder): Promise<void> {
    const picked = folder ?? (await (window as unknown as {
      showDirectoryPicker(o: { id: string; mode: 'readwrite' }): Promise<Folder>;
    }).showDirectoryPicker({ id: 'listik-backup', mode: 'readwrite' }));
    this.folder = picked;
    await this.remember(picked);
    this.set({ state: 'on', folder: picked.name });
    await this.write();
  }

  /** Asks for access again (needs a user gesture) and catches up. */
  async resume(): Promise<void> {
    if (!this.folder) return;
    const permission = (await this.folder.requestPermission?.({ mode: 'readwrite' })) ?? 'granted';
    if (permission !== 'granted') return;
    this.set({ state: 'on', folder: this.folder.name, last: this.status.last });
    await this.write();
  }

  async disable(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.folder = null;
    await this.remember(null);
    this.set({ state: 'off' });
  }

  commit(): void {
    this.dirty = true;
    if (this.writing()) this.schedule();
  }

  async writeIfDirty(): Promise<void> {
    if (this.dirty && this.writing()) await this.write();
  }

  /** Copies go on while on, and after a failed write too: one error (a busy disk) no longer stopped them for good. */
  private writing(): boolean {
    return this.status.state === 'on' || this.status.state === 'error';
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.writeIfDirty();
    }, INTERVAL);
  }

  /** Writes today's copy now. */
  async write(): Promise<void> {
    const folder = this.folder;
    if (!folder) return;
    try {
      const text = toMarkdown(this.doc);
      this.dirty = false;
      const file = await folder.getFileHandle(backupName(this.now()), { create: true });
      const out = await file.createWritable();
      await out.write(text);
      await out.close();
      this.set({ state: 'on', folder: folder.name, last: this.now() });
    } catch (e) {
      this.dirty = true;
      // Access taken back: only a gesture gives it again (`resume`). Anything else is tried again later.
      const lost = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.set({ state: lost ? 'paused' : 'error', folder: folder.name, last: this.status.last, error: String(e) });
      if (!lost) this.schedule();
    }
  }

  close(): void {
    this.db.close();
  }

  /** Real folder handles survive in IndexedDB; a fake one may not clone, and then lasts for the session. */
  private async remember(folder: Folder | null): Promise<void> {
    try {
      const tx = this.db.transaction('meta', 'readwrite');
      if (folder) tx.objectStore('meta').put(folder, KEY);
      else tx.objectStore('meta').delete(KEY);
      await done(tx);
    } catch {
      // Not cloneable (tests): kept in memory only.
    }
  }

  private set(status: BackupStatus): void {
    this.status = status;
    for (const l of this.listeners) l(status);
  }
}
