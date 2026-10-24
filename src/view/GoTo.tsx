import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { dayOf, periodName } from '../model/calendar';
import { findPlaces, meansToday, placeOf, type Place } from '../model/places';
import { searchable } from '../model/tags';
import type { Outliner } from './outliner';
import { touch } from './screen';

/** Places listed for what is typed, and recent ones before anything is. */
const PLACES = 8;
const RECENT = 5;

/** A place in the list, or today's day ("today", "сегодня" typed), which may not be in the calendar yet. */
type Item = Place & { today?: true };

/** Today's day, the date where a place's path is. */
const todayItem = (): Item => ({ id: '', title: 'Сегодня', path: [periodName(dayOf(new Date()))], today: true });

/** The path to a place, its nearest two steps: the rest is in the tooltip. */
const shortPath = (p: Place) => (p.path.length > 2 ? ['…', ...p.path.slice(-2)] : p.path).join(' › ');

/**
 * The places line: "Перейти к…" (Ctrl+K) and "Переместить в…" (Ctrl+Shift+M,
 * "Куда…" on the editing bar). One line in the middle of the screen over
 * the dimmed outline, places under it: bullets whose title holds what is
 * typed (model/places.ts), or, before anything is typed, the places gone to
 * lately (moving: where bullets went lately first). "today" or "сегодня"
 * (its start) puts today's day first, as «Сегодня» in the header. What is typed is only a
 * name: the search and the outline stay as they are.
 *
 * The first place is chosen: Enter takes it (going, the keyboard on into its
 * first bullet), ↑/↓ choose another, a click takes one. Moving leaves out
 * the moved bullets and what is inside them. Esc, × or a press outside close
 * it with nothing done, the caret back where it was in the outline.
 *
 * A computer's: a phone has no "Перейти к…" (its search is enough, and the
 * list would cover half its screen); "Куда…" opens the line at the top.
 */
export function GoTo(props: { o: Outliner }) {
  return (
    <Show when={props.o.placeLine()}>
      <Line o={props.o} />
    </Show>
  );
}

function Line(props: { o: Outliner }) {
  const o = props.o;
  let input!: HTMLInputElement;
  const moving = () => o.moving();
  const [text, setText] = createSignal('');
  const [places, setPlaces] = createSignal<Item[]>([]);
  /** What the places listed were looked up for: "nothing found" waits for the lookup. */
  const [looked, setLooked] = createSignal('');
  /** The chosen place, the one Enter takes. */
  const [active, setActive] = createSignal(0);

  /** The places for the line as it is: those found by the words typed, or recent ones. */
  const lookUp = () => {
    const q = text();
    const m = moving();
    const skip = m ? (id: string) => o.moveRefuses(id) : undefined;
    const recent = m ? [...new Set([...o.recentTargets(), ...o.recentPlaces()])] : o.recentPlaces().filter((id) => id !== o.zoom());
    const today = !m && o.structure() && meansToday(q) ? [todayItem()] : [];
    setPlaces(
      q.trim()
        ? [...today, ...findPlaces(o.doc, o.text, q, PLACES, skip)]
        : recent
            .filter((id) => o.doc.has(id) && searchable(o.doc, id) && !skip?.(id))
            .slice(0, RECENT)
            .map((id) => placeOf(o.doc, id)),
    );
    setLooked(q);
    setActive(0);
  };
  // Looking places up is a pass over every bullet: after the frame that shows what is typed.
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
  createEffect(on([text, o.recentPlaces], ([q]) => {
    cancel();
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

  onMount(() => input.focus());

  /** Goes to a place, or moves the rows into it; either way the line closes. */
  const take = (place: Item, edit: boolean) => {
    if (place.today) o.goToTodayPlace();
    else if (moving()) o.moveInto(place.id);
    else o.goToPlace(place.id, edit);
  };

  /** While more of the list lies below, its bottom edge fades: it scrolls. */
  const fade = (el: HTMLElement) => {
    const more = () => el.classList.toggle('more', el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    el.addEventListener('scroll', more, { passive: true });
    new ResizeObserver(more).observe(el);
    queueMicrotask(more);
  };
  /** The chosen place stays in sight as ↑/↓ go through a list that scrolls. */
  createEffect(on(active, () => {
    queueMicrotask(() => document.querySelector('.goto-list [data-active]')?.scrollIntoView({ block: 'nearest' }));
  }));

  const onKeyDown = (e: KeyboardEvent) => {
    // The line's own keys: none of them reaches the outline's.
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') settle();
    const list = places();
    if (e.key === 'Escape') {
      e.preventDefault();
      o.closePlaceLine();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      const i = active();
      setActive(e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (list.length) take(list[active()], true);
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
      e.preventDefault();
      input.select();
    }
  };

  const label = () => (moving() ? 'Куда переместить' : text().trim() ? 'Места' : 'Недавние места');

  return (
    <>
      <div class="goto-scrim" aria-hidden="true" />
      {/* Presses inside never take focus from the line, so the keyboard stays on a phone. */}
      <div class="goto" role="dialog" aria-label={moving() ? 'Переместить' : 'Перейти к пункту'} onMouseDown={(e) => e.target !== input && e.preventDefault()}>
        <div class="goto-line">
          <Show
            when={moving()}
            fallback={
              <svg class="goto-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="m13 6 6 6-6 6" />
              </svg>
            }
          >
            {/* An arrow into a box: what is typed is where the bullets go. */}
            <svg class="goto-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 12h11" />
              <path d="M11 8l4 4-4 4" />
              <path d="M19 5v14" />
            </svg>
          </Show>
          <input
            ref={input}
            class="goto-input"
            type="text"
            enterkeyhint="go"
            autocomplete="off"
            spellcheck={false}
            placeholder={moving() ? `Переместить ${moving()!.label} в…` : 'Перейти к пункту…'}
            aria-label={moving() ? `Переместить ${moving()!.label} в` : 'Перейти к пункту'}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={() => o.closePlaceLine()}
          />
          <Show when={touch()} fallback={<span class="goto-hint" aria-hidden="true">{moving() ? 'Enter — переместить · Esc' : 'Enter — перейти · Esc'}</span>}>
            <button type="button" class="goto-close" aria-label="Закрыть" onClick={() => o.closePlaceLine()}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
              </svg>
            </button>
          </Show>
        </div>
        <Show
          when={places().length}
          fallback={
            <Show when={text().trim() && looked() === text()}>
              <div class="goto-empty">{moving() ? 'Нет места с таким названием' : 'Нет пункта с таким названием'}</div>
            </Show>
          }
        >
          <div ref={fade} class="goto-list">
            <Show when={!text().trim()}>
              <div class="goto-label" aria-hidden="true">Недавние</div>
            </Show>
            <div role="listbox" aria-label={label()}>
              <For each={places()}>
                {(p, i) => (
                  <div
                    role="option"
                    class="place"
                    aria-selected={i() === active()}
                    data-active={i() === active() ? '' : undefined}
                    title={p.today ? `${p.title}, ${p.path[0]}` : [...p.path, p.title].join(' › ')}
                    onPointerMove={() => i() !== active() && setActive(i())}
                    onClick={() => take(p, false)}
                  >
                    <span class="place-title">{p.title}</span>
                    <Show when={p.path.length}>
                      <span class="place-path">{shortPath(p)}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </>
  );
}
