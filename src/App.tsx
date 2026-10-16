import { Match, Switch, createResource } from 'solid-js';
import { demoDoc, sampleDoc } from './dev/sample';
import { Persistence } from './persist/idb';
import { Outline } from './view/Outline';
import { Outliner } from './view/outliner';

/**
 * The outline is stored in IndexedDB (`?db=name` picks the database).
 * `?demo` and `?sample=200000` open in-memory documents instead and never
 * touch stored data.
 */
async function load(): Promise<Outliner> {
  const params = new URLSearchParams(location.search);
  const sample = Number(params.get('sample'));
  if (sample > 0) {
    const started = performance.now();
    const outliner = new Outliner(sampleDoc(sample));
    console.info(`sample: ${outliner.rows.length} rows in ${Math.round(performance.now() - started)} ms`);
    return outliner;
  }
  if (params.has('demo')) return new Outliner(demoDoc());
  const started = performance.now();
  const { doc } = await Persistence.open(params.get('db') ?? 'listik');
  console.info(`loaded ${doc.nodes.size - 1} bullets in ${Math.round(performance.now() - started)} ms`);
  return new Outliner(doc);
}

export default function App() {
  const [outliner] = createResource(load);
  return (
    <Switch>
      <Match when={outliner.error}>
        <p class="message">Не удалось загрузить документ: {String(outliner.error)}</p>
      </Match>
      <Match when={outliner()}>{(o) => <Outline o={o()} />}</Match>
    </Switch>
  );
}
