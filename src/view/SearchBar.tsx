import { Show, createEffect, on } from 'solid-js';
import { plural } from '../util/plural';
import type { Outliner } from './outliner';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * The search box. Words must all occur in a bullet, "quoted phrases" as a
 * whole, `#tags` come from the tag index. Clicking a tag anywhere fills it in.
 */
export function SearchBar(props: { o: Outliner }) {
  const o = props.o;
  let input!: HTMLInputElement;

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
        placeholder="Поиск по тексту и #тегам"
        title="Слова через пробел, «фраза в кавычках», #тег"
        spellcheck={false}
        value={o.query()}
        onInput={(e) => o.setQuery(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <Show when={o.filter()}>
        {(f) => <span class="count">{f().count} {plural(f().count, 'bullet', 'bullet’а', 'bullet’ов')}</span>}
      </Show>
      <Show
        when={o.query()}
        fallback={<kbd aria-hidden="true">{IS_MAC ? '⌘ F' : 'Ctrl F'}</kbd>}
      >
        <button type="button" class="clear" title="Сбросить (Esc)" aria-label="Сбросить поиск" onClick={() => o.setQuery('', true)}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </button>
      </Show>
    </div>
  );
}
