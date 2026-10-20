import { For, Show, createMemo, createSignal } from 'solid-js';
import { plainText } from '../model/format';
import { TRASH_TTL, placeIsThere, type Deleted } from '../model/trash';
import type { NodeId } from '../model/types';
import { plural } from '../util/plural';
import type { Outliner } from './outliner';

/** Entries listed at most; the filter narrows the rest down. */
const SHOWN = 100;

interface Item {
  entry: Deleted;
  text: string;
  /** No text of its own: the note's first line stands in, set apart. */
  stand: boolean;
  inside: number;
  /** Where it was: the last two steps of the path, the whole path in the tooltip; `gone` when it cannot go back there. */
  where: string;
  path: string;
  gone: boolean;
  time: string;
}

interface Day {
  label: string;
  items: Item[];
}

const two = (n: number) => String(n).padStart(2, '0');

function dayLabel(at: number, now: Date): string {
  const d = new Date(at);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/**
 * The trash, as a panel beside the outline (below it on a phone), not a
 * dialog: the outline keeps the caret and goes on working, and the panel
 * stays open, listing what was deleted as it is deleted. Each block shows
 * its text, what is inside it, where it was and when; "Вернуть" puts it back
 * there (`Outliner.restoreDeleted`) with the caret in it. Buttons take no
 * focus from the row being edited; only the filter field does.
 */
export function Trash(props: { o: Outliner }) {
  const o = props.o;
  const [query, setQuery] = createSignal('');

  const title = (id: NodeId) => plainText(o.doc.content(id).text).trim() || '…';
  // What is inside a deleted block hardly changes in the trash, and a block may be big: counted once.
  const insides = new Map<NodeId, number>();
  const inside = (id: NodeId) => {
    let n = insides.get(id);
    if (n === undefined) {
      n = -1;
      o.doc.walk(o.doc.host(id)?.id ?? id, () => n!++);
      insides.set(id, (n = Math.max(0, n)));
    }
    return n;
  };

  const items = createMemo((): Item[] => {
    const doc = o.doc;
    return o.deleted().map((entry) => {
      const c = doc.content(entry.id);
      const own = plainText(c.text).trim();
      const there = placeIsThere(doc, entry.from.parent);
      const names: string[] = [];
      if (there) for (let p: NodeId | null = entry.from.parent; p !== null && p !== doc.root; p = doc.get(p).parent) names.unshift(title(p));
      const d = new Date(entry.at);
      return {
        entry,
        text: own || c.note.split('\n')[0].trim(),
        stand: !own,
        inside: inside(entry.id),
        where: there ? ['Главная', ...names].slice(-2).join(' › ') : doc.has(entry.from.parent) ? 'из удалённого пункта' : 'место удалено',
        path: there ? ['Главная', ...names].join(' › ') : 'Вернётся в конец списка',
        gone: !there,
        time: `${two(d.getHours())}:${two(d.getMinutes())}`,
      };
    });
  });

  const found = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? items().filter((it) => it.text.toLowerCase().includes(q) || o.doc.content(it.entry.id).note.toLowerCase().includes(q)) : items();
  });

  const days = createMemo((): Day[] => {
    const now = new Date();
    const out: Day[] = [];
    for (const it of found().slice(0, SHOWN)) {
      const label = dayLabel(it.entry.at, now);
      if (out[out.length - 1]?.label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push(it);
    }
    return out;
  });

  const onFilterKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (query()) setQuery('');
    else (e.currentTarget as HTMLInputElement).blur();
  };

  return (
    <aside class="trash" aria-label="Корзина">
      <div class="trash-head">
        <h2>Корзина</h2>
        <Show when={items().length}>
          <span class="trash-count">{items().length}</span>
        </Show>
        <button
          type="button"
          class="trash-close"
          title="Закрыть корзину"
          aria-label="Закрыть корзину"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => o.showTrash(false)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
      <Show when={items().length}>
        <input
          class="trash-filter"
          type="search"
          placeholder="Найти в удалённом"
          aria-label="Найти в удалённом"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onFilterKey}
        />
      </Show>
      <div class="trash-list">
        <Show
          when={days().length}
          fallback={
            <p class="trash-empty">
              {items().length ? 'Ничего не нашлось' : 'Корзина пуста. Удалённые пункты появятся здесь, и их можно будет вернуть на место.'}
            </p>
          }
        >
          <For each={days()}>
            {(day) => (
              <section class="trash-day">
                <h3>{day.label}</h3>
                <For each={day.items}>
                  {(it) => (
                    <div class="trash-item">
                      <div class="trash-text" classList={{ stand: it.stand }}>{it.text || 'Пустой пункт'}</div>
                      <div class="trash-meta" title={it.path}>
                        {it.time}
                        <Show when={it.inside}>
                          {' · '}+{it.inside} {plural(it.inside, 'вложенный', 'вложенных', 'вложенных')}
                        </Show>
                        {' · '}
                        <span classList={{ gone: it.gone }}>{it.where}</span>
                      </div>
                      <button
                        type="button"
                        class="trash-restore"
                        disabled={o.readOnly}
                        title={o.readOnly ? 'Только просмотр: документ открыт в другой вкладке' : it.gone ? 'Вернуть в конец списка' : `Вернуть: ${it.path}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => o.restoreDeleted(it.entry.id)}
                      >
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M6 3.5 2.5 7 6 10.5" />
                          <path d="M3 7h6.5a4 4 0 0 1 0 8H8" />
                        </svg>
                        Вернуть
                      </button>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
          <Show when={found().length > SHOWN}>
            <p class="trash-more">Ещё {found().length - SHOWN} — уточните поиск</p>
          </Show>
        </Show>
      </div>
      <p class="trash-foot">Удалённое хранится {Math.round(TRASH_TTL / 86_400_000)} дней</p>
    </aside>
  );
}
