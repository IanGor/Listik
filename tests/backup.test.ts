import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cmd from '../src/model/commands';
import { VisibleRows } from '../src/model/rows';
import { Backup, backupName, type Folder } from '../src/persist/backup';
import { build } from './helpers';

/** An in-memory folder: file name → contents. */
function fakeFolder(permission: PermissionState = 'granted') {
  const files = new Map<string, string>();
  let granted = permission;
  const folder: Folder = {
    name: 'Бэкапы',
    async getFileHandle(name) {
      return {
        async createWritable() {
          let data = '';
          return {
            async write(d: string) { data += d; },
            async close() { files.set(name, data); },
          };
        },
      };
    },
    async queryPermission() { return granted; },
    async requestPermission() { granted = 'granted'; return granted; },
  };
  return { folder, files };
}

let dbCounter = 0;
afterEach(() => vi.useRealTimers());

describe('Backup', () => {
  it('names one file per day', () => {
    expect(backupName(new Date(2026, 9, 7, 23, 59).getTime())).toBe('listik-2026-10-07.md');
  });

  it('writes a Markdown copy when a folder is chosen, then after edits at most every 5 minutes', async () => {
    const doc = build(['Том первый', '  Часть первая']);
    let now = new Date(2026, 9, 17, 12, 0).getTime();
    const backup = await Backup.open(`backup-${dbCounter++}`, doc, () => now);
    const { folder, files } = fakeFolder();
    const statuses: string[] = [];
    backup.subscribe((s) => statuses.push(s.state));

    await backup.choose(folder);
    expect(files.get('listik-2026-10-17.md')).toBe('- Том первый\n  - Часть первая\n');
    expect(backup.status).toMatchObject({ state: 'on', folder: 'Бэкапы', last: now });

    vi.useFakeTimers();
    const ctx = { doc, rows: new VisibleRows(doc) };
    doc.transact(() => cmd.setText(ctx, 'Том первый', 'Том первый!'));
    expect(files.get('listik-2026-10-17.md')).not.toContain('!');
    now += 5 * 60_000;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(files.get('listik-2026-10-17.md')).toContain('Том первый!');

    // A later day starts a new file; nothing written when nothing changed.
    now = new Date(2026, 9, 18, 9, 0).getTime();
    await backup.writeIfDirty();
    expect(files.has('listik-2026-10-18.md')).toBe(false);
    doc.transact(() => cmd.setText(ctx, 'Том первый', 'Том 1'));
    await backup.writeIfDirty();
    expect(files.get('listik-2026-10-18.md')).toContain('Том 1');
    expect(statuses.every((s) => s === 'on')).toBe(true);
    backup.close();
  });

  it('stays paused without access until resumed, and stops when disabled', async () => {
    const doc = build(['a']);
    const backup = await Backup.open(`backup-${dbCounter++}`, doc);
    const { folder, files } = fakeFolder('prompt');
    await backup.choose(folder);
    await backup.disable();
    expect(backup.status.state).toBe('off');
    const ctx = { doc, rows: new VisibleRows(doc) };
    files.clear();
    doc.transact(() => cmd.setText(ctx, 'a', 'b'));
    await backup.writeIfDirty();
    expect(files.size).toBe(0);
    backup.close();
  });
});
