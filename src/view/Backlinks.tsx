import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { plainText } from '../model/format';
import { backlinks } from '../model/links';
import type { NodeId } from '../model/types';
import type { Outliner } from './outliner';

/** Places shown before "ещё N". */
const SHOWN = 12;
/** Quiet time after an edit before backlinks are looked up again, ms: a lookup is a pass over every bullet. */
const SETTLE = 400;

/** A place a link to the bullet stands in: the parent of the bullet with the link. */
interface Place {
  /** The bullet with the link (the one followed, if the place holds several): where the caret goes. */
  from: NodeId;
  label: string;
  /** The place's path, for the tooltip. */
  path: string;
  /** Where the link just followed came from: the way back, first and marked. */
  back: boolean;
}

/**
 * Backlinks under the zoomed-in bullet's list: a chip per place that links
 * here with a `[[link]]` (model/links.ts), named after the place, the
 * parent of the bullet holding the link. A chip leads there, the caret on
 * that bullet (`Outliner.goToBacklink`). The place the link just followed
 * came from comes first, marked "←": the way back. Mirrors are not links
 * and are not counted.
 *
 * Looking them up is a pass over every bullet (tens of ms on 200k), so it
 * runs after the zoom has drawn, and again once edits settle.
 */
export function Backlinks(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  const [places, setPlaces] = createSignal<Place[]>([]);
  const [all, setAll] = createSignal(false);

  const title = (n: NodeId | null) => (n === null || n === o.doc.root ? 'Главная' : plainText(o.doc.get(n).text).trim() || '…');
  const pathOf = (n: NodeId | null) => {
    const out: string[] = [];
    for (let p = n; p !== null && p !== o.doc.root; p = o.doc.get(p).parent) out.unshift(title(p));
    return ['Главная', ...out].join(' › ');
  };

  const lookUp = () => {
    if (!o.doc.has(id)) return setPlaces([]);
    const came = o.cameFrom();
    const back = came?.to === id ? came.from : null;
    const byParent = new Map<NodeId | null, Place>();
    for (const from of backlinks(o.doc, o.text, id)) {
      const parent = o.doc.get(from).parent;
      const place = byParent.get(parent);
      if (!place) byParent.set(parent, { from, label: title(parent), path: pathOf(parent), back: from === back });
      else if (from === back) Object.assign(place, { from, back: true });
    }
    const list = [...byParent.values()];
    const i = list.findIndex((p) => p.back);
    if (i > 0) list.unshift(...list.splice(i, 1));
    setPlaces(list);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const schedule = (delay: number) => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    // After the next frame, so the zoom or the typed character shows first.
    timer = setTimeout(() => (frame = requestAnimationFrame(() => (timer = setTimeout(lookUp)))), delay);
  };
  onMount(() => {
    schedule(0);
    const unsubscribe = o.doc.subscribe({ commit: () => schedule(SETTLE) });
    onCleanup(() => {
      unsubscribe();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    });
  });

  const shown = () => (all() ? places() : places().slice(0, SHOWN));

  return (
    <Show when={places().length}>
      <nav class="backlinks" aria-label="Ссылки сюда">
        <span class="backlinks-label">Ссылки сюда</span>
        <For each={shown()}>
          {(p) => (
            <button
              type="button"
              class="backlink"
              classList={{ back: p.back }}
              title={p.back ? `Назад: ${p.path}` : p.path}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => o.goToBacklink(p.from, id)}
            >
              <Show when={p.back}>
                <span class="backlink-arrow" aria-hidden="true">←</span>
              </Show>
              <span class="backlink-label">{p.label}</span>
            </button>
          )}
        </For>
        <Show when={!all() && places().length > SHOWN}>
          <button type="button" class="backlink more" onClick={() => setAll(true)}>
            ещё {places().length - SHOWN}
          </button>
        </Show>
      </nav>
    </Show>
  );
}
