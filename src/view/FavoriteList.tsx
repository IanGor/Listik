import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { calendarName } from '../model/calendar';
import { titleOf } from '../model/links';
import { pathOf } from '../model/places';
import type { Outliner } from './outliner';
import { Star } from './SearchBar';
import { touchCapable } from './screen';

type Entry = { kind: 'heading'; text: string } | { kind: 'node'; id: string } | { kind: 'search'; query: string };

/** Two kinds of shortcuts, one virtualized block; no destructive controls here. */
export function FavoriteList(props: { o: Outliner; labelVersion: () => number; navigate: (id: string) => void; search: (query: string) => void }) {
  const o = props.o;
  const entries = createMemo(() => {
    const nodes = o.favoriteNodes(), queries = o.savedSearches();
    const out: Entry[] = [];
    if (nodes.length) out.push({ kind: 'heading', text: 'Ноды' }, ...nodes.map((id): Entry => ({ kind: 'node', id })));
    if (queries.length) out.push({ kind: 'heading', text: 'Поиски' }, ...queries.map((query): Entry => ({ kind: 'search', query })));
    return out;
  });
  const rowHeight = touchCapable() ? 48 : 42;
  const [top, setTop] = createSignal(0), [height, setHeight] = createSignal(220);
  const first = () => Math.max(0, Math.floor(top() / rowHeight) - 3);
  const shown = createMemo(() => entries().slice(first(), first() + Math.ceil(height() / rowHeight) + 6));
  let scroll!: HTMLDivElement;
  createEffect(() => {
    const maximum = Math.max(0, entries().length * rowHeight - height());
    if (top() > maximum) { setTop(maximum); if (scroll) scroll.scrollTop = maximum; }
  });
  const observe = (el: HTMLDivElement) => {
    scroll = el;
    const resize = new ResizeObserver(() => setHeight(el.clientHeight));
    resize.observe(el);
    onCleanup(() => resize.disconnect());
  };
  onMount(() => { if (scroll) setHeight(scroll.clientHeight); });
  const label = (entry: Entry): string => {
    props.labelVersion();
    return entry.kind === 'node' ? calendarName(o.doc, entry.id, 'crumb') ?? (titleOf(o.doc.get(entry.id).text) || 'Без названия') : entry.kind === 'search' ? entry.query : entry.text;
  };
  const path = (entry: Entry) => { props.labelVersion(); return entry.kind === 'node' ? pathOf(o.doc, entry.id) : []; };
  const keys = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const current = Number((e.target as HTMLElement).closest<HTMLElement>('[data-favorite-index]')?.dataset.favoriteIndex ?? 0);
    let next = e.key === 'Home' ? 0 : e.key === 'End' ? entries().length - 1 : current + (e.key === 'ArrowDown' ? 1 : -1);
    const step = e.key === 'End' || e.key === 'ArrowUp' ? -1 : 1;
    while (entries()[next]?.kind === 'heading') next += step;
    if (!entries()[next]) return;
    const y = next * rowHeight;
    if (y < scroll.scrollTop) scroll.scrollTop = y;
    else if (y + rowHeight > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y + rowHeight - scroll.clientHeight;
    setTop(scroll.scrollTop);
    queueMicrotask(() => scroll.querySelector<HTMLButtonElement>(`[data-favorite-index="${next}"] button`)?.focus());
  };

  return <Show when={entries().length}>
    <section class="sidebar-favorites" aria-label="Избранное">
      <div class="navigation-section-label">Избранное</div>
      <div ref={observe} class="favorite-scroll" onKeyDown={keys} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div class="favorite-list" role="list" aria-label="Избранное" style={{ height: `${entries().length * rowHeight}px` }}>
          <For each={shown()}>{(entry) => {
            const index = () => first() + shown().indexOf(entry);
            return <div class="favorite-entry" role={entry.kind === 'heading' ? 'presentation' : 'listitem'} data-favorite-index={index()} aria-setsize={entry.kind === 'heading' ? undefined : o.favoriteNodes().length + o.savedSearches().length} aria-posinset={entry.kind === 'heading' ? undefined : index() + 1 - (o.favoriteNodes().length && entry.kind === 'search' ? 2 : 1)} style={{ top: `${index() * rowHeight}px`, height: `${rowHeight}px` }}>
              <Show when={entry.kind !== 'heading'} fallback={<span class="favorite-group">{label(entry)}</span>}>
                <button type="button" class="favorite-link"
                  title={[...path(entry), label(entry)].join(' › ')}
                  aria-label={entry.kind === 'node' ? `Открыть ноду «${label(entry)}»` : `Выполнить поиск «${label(entry)}»`}
                  aria-current={entry.kind === 'node' && o.zoom() === entry.id ? 'page' : undefined}
                  onClick={() => { if (entry.kind === 'node') props.navigate(entry.id); else if (entry.kind === 'search') props.search(entry.query); }}>
                  <Show when={entry.kind === 'node'} fallback={<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>}>
                    <Star filled size={17} />
                  </Show>
                  <span class="favorite-caption"><span>{label(entry)}</span><Show when={path(entry).length}><small>{path(entry).slice(-2).join(' › ')}</small></Show></span>
                </button>
              </Show>
            </div>;
          }}</For>
        </div>
      </div>
    </section>
  </Show>;
}
