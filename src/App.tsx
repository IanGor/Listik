import { Match, Switch, createResource, createSignal } from 'solid-js';
import { demoDoc, sampleDoc } from './dev/sample';
import { Backup } from './persist/backup';
import { Persistence } from './persist/idb';
import { acquireWriteLock } from './persist/lock';
import { codecFor, openVault, startSync, type Opened } from './sync/setup';
import { Outline } from './view/Outline';
import { Outliner } from './view/outliner';
import { Unlock } from './view/Unlock';

/**
 * The outline is stored in IndexedDB (`?db=name` picks the database).
 * `?demo` and `?sample=200000` open in-memory documents instead and never
 * touch stored data. An encrypted document whose key this device does not
 * remember shows the unlock screen first.
 */
async function load(): Promise<Outliner | { locked: Opened }> {
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

async function open(name: string, opened: Opened): Promise<Outliner> {
  const codec = await codecFor(opened.secret);
  // Another tab is editing this document: show it read-only, and reload into
  // the writer's seat as soon as that tab goes away.
  if (!(await acquireWriteLock(name, () => location.reload()))) {
    const outliner = new Outliner(await Persistence.read(name, codec), { readOnly: true });
    opened.db.close();
    return outliner;
  }
  const started = performance.now();
  const { doc, persistence } = await Persistence.open(name, codec);
  console.info(`loaded ${doc.nodes.size - 2} bullets in ${Math.round(performance.now() - started)} ms`);
  const outliner = new Outliner(doc);
  outliner.persistence = persistence;
  outliner.opened = opened;
  persistence.onError = (e) => outliner.notify(`Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`);
  outliner.backup = await Backup.open(name, doc);
  outliner.syncHandle = await startSync(doc, opened);
  outliner.watchSync();
  return outliner;
}

export default function App() {
  const [unlocked, setUnlocked] = createSignal<Opened | null>(null);
  const [loaded] = createResource(load);
  const [reopened] = createResource(unlocked, (opened) => open(new URLSearchParams(location.search).get('db') ?? 'listik', opened));
  const outliner = () => {
    const r = reopened();
    if (r) return r;
    const l = loaded();
    return l instanceof Outliner ? l : undefined;
  };
  const locked = () => {
    const l = loaded();
    return l && !(l instanceof Outliner) && !unlocked() ? l.locked : null;
  };
  const error = () => loaded.error ?? reopened.error;
  return (
    <Switch>
      <Match when={error()}>
        <p class="message">Не удалось загрузить документ: {String(error())}</p>
      </Match>
      <Match when={locked()}>{(opened) => <Unlock opened={opened()} onUnlocked={() => setUnlocked(opened())} />}</Match>
      <Match when={outliner()}>{(o) => <Outline o={o()} />}</Match>
    </Switch>
  );
}
