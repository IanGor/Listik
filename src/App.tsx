import { Match, Switch, createResource, createSignal } from 'solid-js';
import { demoDoc, sampleDoc } from './dev/sample';
import { Backup } from './persist/backup';
import { Persistence } from './persist/idb';
import { acquireWriteLock } from './persist/lock';
import { codecFor, openVault, requestRestore, restoreFromServer, startSync, takeRestore, type Opened } from './sync/setup';
import { Outline } from './view/Outline';
import { Outliner } from './view/outliner';
import { Restore } from './view/Restore';
import { Unlock } from './view/Unlock';

/**
 * The outline is stored in IndexedDB (`?db=name` picks the database).
 * `?demo` and `?sample=200000` open in-memory documents instead and never
 * touch stored data. An encrypted document whose key this device does not
 * remember shows the unlock screen first; one whose local copy does not open
 * with the key it remembers offers to restore that copy from the server.
 */
async function load(): Promise<Outliner | { locked: Opened } | { damaged: Opened }> {
  const params = new URLSearchParams(location.search);
  const sample = Number(params.get('sample'));
  if (sample > 0) {
    const started = performance.now();
    const outliner = new Outliner(sampleDoc(sample));
    console.info(`sample: ${outliner.rows.length} rows in ${Math.round(performance.now() - started)} ms`);
    return outliner;
  }
  if (params.has('demo')) return new Outliner(demoDoc());
  const name = params.get('db') ?? 'listik';
  const opened = await openVault(name);
  if (opened.keyslot && !opened.secret) return { locked: opened };
  return open(name, opened);
}

async function open(name: string, opened: Opened): Promise<Outliner | { damaged: Opened }> {
  const codec = await codecFor(opened.secret);
  // Another tab is editing this document: show it read-only, and reload into
  // the writer's seat as soon as that tab goes away.
  if (!(await acquireWriteLock(name, () => location.reload()))) {
    const outliner = new Outliner(await Persistence.read(name, codec), { readOnly: true });
    opened.db.close();
    return outliner;
  }
  // Asked for in the sync dialog (or after a log with a gap): the server's copy replaces this one before it opens.
  let restored: string | null = null;
  if (await takeRestore(opened)) {
    try {
      await restoreFromServer(opened);
      restored = 'Документ загружен с сервера';
    } catch (e) {
      restored = `Не удалось загрузить с сервера: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const started = performance.now();
  let stored: Awaited<ReturnType<typeof Persistence.open>>;
  try {
    stored = await Persistence.open(name, codec);
  } catch (e) {
    // AES-GCM refuses a record sealed with another key: the copy here is
    // damaged, the server's is not.
    if (opened.config && opened.secret && e instanceof DOMException && e.name === 'OperationError') return { damaged: opened };
    throw e;
  }
  const { doc, persistence, fresh, merged } = stored;
  console.info(`loaded ${doc.nodes.size - 2} bullets in ${Math.round(performance.now() - started)} ms`);
  if (merged) console.warn(`the log skipped a batch: ${merged} ops merged`);
  const outliner = new Outliner(doc);
  outliner.bare = new URLSearchParams(location.search).has('empty');
  outliner.keepFolds(name);
  outliner.keepRecent(name);
  outliner.docName = name;
  outliner.foldCalendar(name);
  // A new document starts with the structure (model/calendar.ts).
  if (fresh) outliner.firstStructure(true);
  outliner.persistence = persistence;
  outliner.opened = opened;
  // null: what failed is on disk now (idb.ts keeps it and tries again).
  persistence.onError = (e) => outliner.notify(e === null ? 'Правки сохранены' : `Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`);
  outliner.backup = await Backup.open(name, doc);
  outliner.syncHandle = await startSync(doc, opened, persistence);
  outliner.watchSync();
  outliner.tagYears();
  if (restored) outliner.notify(restored);
  else if (merged) {
    const handle = outliner.syncHandle;
    // The lost ops may have reached the server (the sync tail is cumulative): its copy is the whole one.
    outliner.notify(
      'Часть прежних правок не дошла до диска: документ собран из сохранённого',
      handle ? { label: 'Взять с сервера', run: () => void requestRestore(handle, persistence, opened).then(() => location.reload()) } : null,
    );
  }
  return outliner;
}

export default function App() {
  const [unlocked, setUnlocked] = createSignal<Opened | null>(null);
  const [loaded] = createResource(load);
  const [reopened] = createResource(unlocked, (opened) => open(new URLSearchParams(location.search).get('db') ?? 'listik', opened));
  const outliner = () => {
    const r = reopened();
    if (r) return r instanceof Outliner ? r : undefined;
    const l = loaded();
    return l instanceof Outliner ? l : undefined;
  };
  const locked = () => {
    const l = loaded();
    return l && 'locked' in l && !unlocked() ? l.locked : null;
  };
  const damaged = () => {
    const r = reopened() ?? loaded();
    return r && 'damaged' in r ? r.damaged : null;
  };
  const error = () => loaded.error ?? reopened.error;
  return (
    <Switch>
      <Match when={error()}>
        <p class="message">Не удалось загрузить документ: {String(error())}</p>
      </Match>
      <Match when={damaged()}>{(opened) => <Restore opened={opened()} />}</Match>
      <Match when={locked()}>{(opened) => <Unlock opened={opened()} onUnlocked={() => setUnlocked(opened())} />}</Match>
      <Match when={outliner()}>{(o) => <Outline o={o()} />}</Match>
    </Switch>
  );
}
