import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { normalize } from '../model/search';
import { plural } from '../util/plural';
import type { Outliner } from './outliner';
import { narrow, still } from './screen';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/** A five-pointed star: outlined, or filled for a saved search. */
const STAR = 'M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.7l-5.12 2.7.98-5.72L3.7 9.64l5.75-.84z';

function Star(props: { filled: boolean; size: number }) {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill={props.filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
      <path d={STAR} />
    </svg>
  );
}

/**
 * The search box. Words must all occur in a bullet, "quoted phrases" as a
 * whole, `#tags` come from the tag index. Clicking a tag anywhere fills it in.
 * Going to a place by its name is the places line's (GoTo.tsx, Ctrl+K).
 *
 * Saved searches: the star keeps what is typed (filled once saved; pressed
 * again, it lets go). With the box focused they drop down below it, the
 * last saved first, narrowed to those holding what is typed; a press runs
 * one, its × takes it out. The list scrolls past its height (index.css).
 */
export function SearchBar(props: { o: Outliner }) {
  const o = props.o;
  let input!: HTMLInputElement;
  const [focused, setFocused] = createSignal(false);
  const saved = () => o.isSaved(o.query());
  /** Saved searches to offer: all of them, or those holding what is typed (not the very same). */
  const offered = () => {
    const q = normalize(o.query().trim());
    const list = o.savedSearches();
    return q ? list.filter((s) => normalize(s) !== q && normalize(s).includes(q)) : list;
  };
  const run = (query: string) => o.setQuery(query, true);
  /** While more of the list lies below, its bottom edge fades: it scrolls. */
  const fade = (el: HTMLElement) => {
    const more = () => el.classList.toggle('more', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    el.addEventListener('scroll', more, { passive: true });
    new ResizeObserver(more).observe(el);
    queueMicrotask(more);
  };

  createEffect(on(o.searchRequests, () => {
    input.focus();
    input.select();
  }, { defer: true }));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      o.setQuery('', true);
      input.blur();
    } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
      // Go edit the first match.
      e.preventDefault();
      o.setQuery(input.value, true);
      const first = o.firstMatch();
      if (first) o.setFocus({ id: first, caret: 0 });
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
      e.preventDefault();
      input.select();
    }
  };

  return (
    <div class="searchbar">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={input}
        class="search"
        type="text"
        placeholder={narrow() ? 'Поиск и #теги' : 'Поиск по тексту и #тегам'}
        title="Слова через пробел, «фраза в кавычках», #тег или @тег; -слово или -#тег исключает; OR — или; is:done — выполненные"
        spellcheck={false}
        value={o.query()}
        onInput={(e) => o.setQuery(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          // Links follow a title just retyped before the search sees it.
          o.settleTitle();
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
      />
      {/* Nothing found has its own words over the list ("Ничего не найдено"): no "0" here too. */}
      <Show when={o.filter()?.count ? o.filter() : null}>
        {(f) => {
          const label = () => `${f().count} ${plural(f().count, 'пункт', 'пункта', 'пунктов')}`;
          let el!: HTMLSpanElement;
          // A new number rises into place, as counters do on Apple's systems.
          createEffect(on(() => f().count, () => {
            if (!still()) el.animate([{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }], { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
          }, { defer: true }));
          // A phone keeps the field for the query: the number alone, the words in the tooltip.
          return <span ref={el} class="count" title={label()}>{narrow() ? f().count : label()}</span>;
        }}
      </Show>
      <Show
        when={o.query().trim()}
        fallback={<kbd aria-hidden="true">{IS_MAC ? '⌘ F' : 'Ctrl F'}</kbd>}
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
      <Show when={focused() && offered().length}>
        {/* Presses never take focus from the box, so the keyboard stays on a phone. */}
        <div ref={fade} class="search-menu" role="list" aria-label="Избранные поиски" onMouseDown={(e) => e.preventDefault()}>
          <div class="search-menu-label" aria-hidden="true">Избранное</div>
          <For each={offered()}>
            {(q) => (
              <div class="saved-search" role="listitem">
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
  );
}
