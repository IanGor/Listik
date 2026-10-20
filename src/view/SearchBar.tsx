import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { asksPlace, findPlaces, placeOf, type Place } from '../model/places';
import { normalize } from '../model/search';
import { plural } from '../util/plural';
import type { Outliner } from './outliner';
import { narrow } from './screen';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Places listed for what is typed, and recent ones before anything is. */
const PLACES = 7;
const RECENT = 5;

/** A five-pointed star: outlined, or filled for a saved search. */
const STAR = 'M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.7l-5.12 2.7.98-5.72L3.7 9.64l5.75-.84z';

function Star(props: { filled: boolean; size: number }) {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill={props.filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
      <path d={STAR} />
    </svg>
  );
}

/** The path to a place, its nearest two steps: the rest is in the tooltip. */
const shortPath = (p: Place) => (p.path.length > 2 ? ['…', ...p.path.slice(-2)] : p.path).join(' › ');

/**
 * The search box, which also goes to places. Words must all occur in a
 * bullet, "quoted phrases" as a whole, `#tags` come from the tag index; the
 * outline below shows what matches. Clicking a tag anywhere fills it in.
 *
 * Its list, while it is focused: places first — bullets whose title holds
 * the words typed (model/places.ts), or, before anything is typed, the
 * places gone to lately — and saved searches after them. With places
 * listed, the first one is chosen: Enter goes there (the keyboard on into
 * its first bullet), ↑/↓ choose another. A search with tags or operators
 * lists no places: Enter edits its first match, as without the list.
 *
 * "Переместить в…" (Ctrl+Shift+M, `Outliner.openMove`) takes the same box
 * over: what is typed there is only a place's name, the outline is left
 * as it is, the list holds places alone — before anything is typed, where
 * bullets went lately, then the recent places — without the moved bullets
 * and what is inside them. Enter moves them into the chosen one; Esc, ×
 * or leaving the box moves nothing.
 *
 * Saved searches: the star keeps what is typed (filled once saved; pressed
 * again, it lets go). They are listed last saved first, narrowed to those
 * holding what is typed; a press runs one, its × takes it out. The list
 * scrolls past its height (index.css).
 */
export function SearchBar(props: { o: Outliner }) {
  const o = props.o;
  let input!: HTMLInputElement;
  const [focused, setFocused] = createSignal(false);
  /** What "Переместить в…" has typed: a name, never a search. */
  const [moveQuery, setMoveQuery] = createSignal('');
  const moving = () => o.moving();
  /** The box's text: the search, or the name of a place to move to. */
  const text = () => (moving() ? moveQuery() : o.query());
  const saved = () => o.isSaved(o.query());
  /** Saved searches to offer: all of them, or those holding what is typed (not the very same); none while moving. */
  const offered = () => {
    if (moving()) return [];
    const q = normalize(o.query().trim());
    const list = o.savedSearches();
    return q ? list.filter((s) => normalize(s) !== q && normalize(s).includes(q)) : list;
  };
  const [places, setPlaces] = createSignal<Place[]>([]);
  /** The chosen entry of the list, places first, then saved searches; -1: none. */
  const [active, setActive] = createSignal(-1);
  const count = () => places().length + offered().length;

  /** The places for the box as it is: recent ones, or those found by the words typed. */
  const lookUp = () => {
    const q = text();
    const usable = (id: string) => o.doc.has(id) && o.doc.inOutline(id);
    let found: Place[];
    if (moving()) {
      const skip = (id: string) => o.moveRefuses(id);
      found = q.trim()
        ? findPlaces(o.doc, o.text, q, PLACES, skip)
        : [...new Set([...o.recentTargets(), ...o.recentPlaces()])]
            .filter((id) => usable(id) && !skip(id))
            .slice(0, RECENT)
            .map((id) => placeOf(o.doc, id));
    } else {
      found = !q.trim()
        ? o.recentPlaces()
            .filter((id) => id !== o.zoom() && usable(id))
            .slice(0, RECENT)
            .map((id) => placeOf(o.doc, id))
        : asksPlace(q) ? findPlaces(o.doc, o.text, q, PLACES) : [];
    }
    setPlaces(found);
    // Moving, the first place is always chosen: Enter is all it takes.
    setActive(found.length && (moving() || q.trim()) ? 0 : -1);
  };
  // Looking places up is a pass over every bullet: after the frame that shows the search.
  let pending: { frame: number; timer?: ReturnType<typeof setTimeout> } | null = null;
  const cancel = () => {
    if (!pending) return;
    cancelAnimationFrame(pending.frame);
    clearTimeout(pending.timer);
    pending = null;
  };
  /** A key that takes from the list sees it for what is typed now. */
  const settle = () => {
    if (!pending) return;
    cancel();
    lookUp();
  };
  createEffect(on([focused, text, o.recentPlaces, moving], ([f, q]) => {
    cancel();
    if (!f) return setPlaces([]);
    if (!q.trim()) return lookUp();
    const p: NonNullable<typeof pending> = { frame: 0 };
    p.frame = requestAnimationFrame(() => {
      p.timer = setTimeout(() => {
        pending = null;
        lookUp();
      });
    });
    pending = p;
  }));
  onCleanup(cancel);

  const run = (query: string) => o.setQuery(query, true);
  const go = (place: Place, edit: boolean) => {
    if (moving()) {
      // The caret goes back into the outline, to the row after the moved ones.
      o.moveInto(place.id);
      if (document.activeElement === input) input.blur();
      return;
    }
    input.blur();
    o.goToPlace(place.id, edit);
  };
  /** Takes the entry `i` of the list: goes to a place, or runs a saved search. */
  const take = (i: number, edit: boolean) => {
    const list = places();
    if (i < list.length) return go(list[i], edit);
    const q = offered()[i - list.length];
    if (q !== undefined) run(q);
  };
  /** While more of the list lies below, its bottom edge fades: it scrolls. */
  const fade = (el: HTMLElement) => {
    const more = () => el.classList.toggle('more', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    el.addEventListener('scroll', more, { passive: true });
    new ResizeObserver(more).observe(el);
    queueMicrotask(more);
  };
  /** The chosen entry stays in sight as ↑/↓ go through a list that scrolls. */
  createEffect(on(active, (i) => {
    if (i >= 0) queueMicrotask(() => document.querySelector('.search-menu [data-active]')?.scrollIntoView({ block: 'nearest' }));
  }));

  createEffect(on(o.searchRequests, () => {
    input.focus();
    input.select();
  }, { defer: true }));

  createEffect(on(moving, (m) => {
    if (!m) return;
    setMoveQuery('');
    input.focus();
  }, { defer: true }));

  /** Moving: Esc, × and leaving the box move nothing. */
  const cancelMove = () => {
    o.cancelMove();
    if (document.activeElement === input) input.blur();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') settle();
    const n = count();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (moving()) return cancelMove();
      o.setQuery('', true);
      input.blur();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      const i = active();
      setActive(e.key === 'ArrowDown' ? (i + 1) % n : i <= 0 ? n - 1 : i - 1);
    } else if (e.key === 'Enter' && active() >= 0) {
      e.preventDefault();
      take(active(), true);
    } else if (moving() && (e.key === 'Enter' || e.key === 'ArrowDown')) {
      // Nowhere to move to for what is typed.
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      // Go edit the first match.
      e.preventDefault();
      o.setQuery(input.value, true);
      const first = o.firstMatch();
      if (first) o.setFocus({ id: first, caret: 0 });
    } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyF' || e.code === 'KeyK')) {
      e.preventDefault();
      input.select();
    }
  };

  return (
    <div class="searchbar" classList={{ moving: !!moving() }}>
      <Show
        when={moving()}
        fallback={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        }
      >
        {/* An arrow into a box: what is typed is where the bullets go. */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 12h11" />
          <path d="M11 8l4 4-4 4" />
          <path d="M19 5v14" />
        </svg>
      </Show>
      <input
        ref={input}
        class="search"
        type="text"
        placeholder={moving() ? `Переместить ${moving()!.label} в…` : narrow() ? 'Перейти или найти' : 'Перейти к пункту или найти: слова, #теги'}
        title="Название пункта — перейти к нему (Enter). Поиск: слова через пробел, «фраза в кавычках», #тег или @тег; -слово или -#тег исключает; OR — или; is:done — выполненные"
        spellcheck={false}
        value={text()}
        onInput={(e) => (moving() ? setMoveQuery(e.currentTarget.value) : o.setQuery(e.currentTarget.value))}
        onKeyDown={onKeyDown}
        onFocus={() => {
          // Links follow a title just retyped before the search sees it.
          o.settleTitle();
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          if (moving()) o.cancelMove();
        }}
      />
      <Show when={moving()}>
        <button type="button" class="clear" title="Не перемещать (Esc)" aria-label="Не перемещать" onMouseDown={(e) => e.preventDefault()} onClick={cancelMove}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </Show>
      <Show when={!moving() && o.filter()}>
        {(f) => <span class="count">{f().count} {plural(f().count, 'bullet', 'bullet’а', 'bullet’ов')}</span>}
      </Show>
      <Show
        when={!moving() && o.query().trim()}
        fallback={<Show when={!moving()}><kbd aria-hidden="true">{IS_MAC ? '⌘ K' : 'Ctrl K'}</kbd></Show>}
      >
        <button
          type="button"
          class="star"
          classList={{ saved: saved() }}
          title={saved() ? 'Убрать из избранного' : 'В избранное'}
          aria-label={saved() ? 'Убрать поиск из избранного' : 'Сохранить поиск в избранное'}
          aria-pressed={saved()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => o.toggleSaved(o.query())}
        >
          <Star filled={saved()} size={17} />
        </button>
        <button type="button" class="clear" title="Сбросить (Esc)" aria-label="Сбросить поиск" onClick={() => o.setQuery('', true)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </Show>
      <Show when={focused() && count()}>
        {/* Presses never take focus from the box, so the keyboard stays on a phone. */}
        <div ref={fade} class="search-menu" onMouseDown={(e) => e.preventDefault()}>
          <Show when={places().length}>
            <div class="search-menu-label" aria-hidden="true">{moving() ? 'Переместить в' : o.query().trim() ? 'Перейти' : 'Недавние'}</div>
            <div role="listbox" aria-label={moving() ? 'Куда переместить' : o.query().trim() ? 'Места' : 'Недавние места'}>
              <For each={places()}>
                {(p, i) => (
                  <div
                    role="option"
                    class="place"
                    aria-selected={i() === active()}
                    data-active={i() === active() ? '' : undefined}
                    title={[...p.path, p.title].join(' › ')}
                    onPointerMove={() => i() !== active() && setActive(i())}
                    onClick={() => go(p, false)}
                  >
                    <span class="place-title">{p.title}</span>
                    <Show when={p.path.length}>
                      <span class="place-path">{shortPath(p)}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={offered().length}>
            <div class="search-menu-label" aria-hidden="true">Избранное</div>
            <div role="list" aria-label="Избранные поиски">
              <For each={offered()}>
                {(q, i) => (
                  <div
                    class="saved-search"
                    role="listitem"
                    data-active={places().length + i() === active() ? '' : undefined}
                  >
                    <button type="button" class="saved-search-run" title={q} onClick={() => run(q)}>
                      <Star filled size={14} />
                      <span>{q}</span>
                    </button>
                    <button type="button" class="saved-search-remove" title="Убрать из избранного" aria-label={`Убрать «${q}» из избранного`} onClick={() => o.toggleSaved(q)}>
                      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                        <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
