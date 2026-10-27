import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { daysIn } from '../model/calendar';
import type { RowKey } from '../model/rows';
import { addDays, compareDates, monthCells, sameDate, type PlanDate } from '../model/today';
import type { Outliner, PlannerRect } from './outliner';

/** Room kept between the calendar and the window's edges, and between it and what it opened beside, px. */
const MARGIN = 8;
/** Of the style (index.css `.planner`): the width it is placed by before it is measured. */
const WIDTH = 296;

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

const monthName = (m: number) => new Date(2000, m - 1, 1).toLocaleString('ru', { month: 'long' });

/**
 * The small calendar that plans bullets for a day (model/today.ts): a day
 * picked puts a mirror of each in that day's `todo` (`Outliner.planFor`),
 * moving the one planned for another day; «Отменить планирование» takes the
 * plan away. It opens beside the row that asked for it: the button at its
 * end, the date in its line, Ctrl+S, the row menu, a swipe to the right.
 * Days gone by are not offered, nor those past the end of next year (a year
 * is made in the calendar whole). The keys go to it while it is open, the
 * caret staying where it is: arrows move the day, PageUp/PageDown the month,
 * Enter plans, Esc closes. A tap or click elsewhere only closes it.
 */
export function Planner(props: { o: Outliner }) {
  return (
    <Show when={props.o.planner()} keyed>
      {(at) => <Calendar o={props.o} keys={at.keys} rect={at.rect} />}
    </Show>
  );
}

function Calendar(props: { o: Outliner; keys: RowKey[]; rect: PlannerRect }) {
  const o = props.o;
  const today = o.todayDate();
  const last: PlanDate = { y: today.y + 1, m: 12, d: 31 };
  let panel!: HTMLDivElement;
  /** A press began on the layer under the calendar (not the click that opened it). */
  let pressed = false;

  // What the rows are planned for now: marked in the grid; with any plan, it can be cancelled.
  const plans = props.keys.flatMap((k) => o.planOf(k)?.date ?? []);
  const start = plans[0] ?? today;
  const [cursor, setCursor] = createSignal<PlanDate>(start);
  const [view, setView] = createSignal({ y: start.y, m: start.m });
  const [place, setPlace] = createSignal({ left: MARGIN, top: MARGIN });

  const close = () => o.closePlanner();
  const out = (d: PlanDate) => compareDates(d, today) < 0 || compareDates(d, last) > 0;
  const pick = (d: PlanDate) => {
    if (out(d)) return;
    close();
    o.planFor(props.keys, d);
  };
  const cancel = () => {
    close();
    o.planFor(props.keys, null);
  };

  const cells = () => monthCells(view().y, view().m);
  const atStart = () => view().y === today.y && view().m === today.m;
  const atEnd = () => view().y === last.y && view().m === last.m;
  const shift = (by: number) => {
    const d = new Date(view().y, view().m - 1 + by, 1);
    setView({ y: d.getFullYear(), m: d.getMonth() + 1 });
  };

  /** The cursor to a day within the offered ones; the month follows it. */
  const move = (d: PlanDate) => {
    const to = compareDates(d, today) < 0 ? today : compareDates(d, last) > 0 ? last : d;
    setCursor(to);
    setView({ y: to.y, m: to.m });
  };
  const byMonths = (by: number) => {
    const c = cursor();
    const d = new Date(c.y, c.m - 1 + by, 1);
    move({ y: d.getFullYear(), m: d.getMonth() + 1, d: Math.min(c.d, daysIn(d.getFullYear(), d.getMonth() + 1)) });
  };

  onMount(() => {
    // Beside what asked for it, inside the window: above it when there is no room below. A narrow screen centres it.
    const { width, height } = panel.getBoundingClientRect();
    const r = props.rect;
    const wide = r.right - r.left > 120;
    const left = innerWidth <= 640 ? (innerWidth - width) / 2 : Math.max(MARGIN, Math.min(wide ? r.right - width : r.left, innerWidth - width - MARGIN));
    const below = r.bottom + MARGIN;
    const top = below + height <= innerHeight - MARGIN ? below : Math.max(MARGIN, r.top - MARGIN - height);
    setPlace({ left, top });

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'Escape' || (mod && !e.shiftKey && !e.altKey && e.code === 'KeyS')) {
        stop();
        return close();
      }
      if (mod || e.altKey) return;
      const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (e.key in step) {
        stop();
        return move(addDays(cursor(), step[e.key]));
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        stop();
        return byMonths(e.key === 'PageUp' ? -1 : 1);
      }
      if (e.key === 'Enter') {
        stop();
        pick(cursor());
      }
    };
    // The list scrolled or the window resized: the row is elsewhere now.
    addEventListener('keydown', onKey, true);
    addEventListener('resize', close);
    addEventListener('scroll', close, true);
    onCleanup(() => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', close);
      removeEventListener('scroll', close, true);
    });
  });

  return (
    <>
      {/* Takes the tap that closes the calendar, so it does nothing to what is under it (as the row menu's does). */}
      <div
        class="row-menu-scrim"
        onPointerDown={(e) => {
          e.preventDefault();
          pressed = true;
        }}
        onClick={() => pressed && close()}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={panel}
        class="menu planner"
        role="dialog"
        aria-label="Запланировать на день"
        style={{ left: `${place().left}px`, top: `${place().top}px`, width: `${WIDTH}px` }}
        // DOM focus stays in the row being edited.
        onMouseDown={(e) => e.preventDefault()}
      >
        <div class="planner-head">
          <button type="button" class="planner-nav" aria-label="Предыдущий месяц" disabled={atStart()} onClick={() => shift(-1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <span class="planner-month" aria-live="polite">
            {monthName(view().m)} {view().y}
          </span>
          <button type="button" class="planner-nav" aria-label="Следующий месяц" disabled={atEnd()} onClick={() => shift(1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
        <div class="planner-grid" role="grid">
          <For each={WEEKDAYS}>{(w) => <span class="planner-weekday" aria-hidden="true">{w}</span>}</For>
          {/* Objects, not the numbers: the blanks are all one value, and a month is rebuilt whole. */}
          <For each={cells().map((d) => ({ d }))}>
            {({ d }) => {
              if (d === null) return <span />;
              const date = (): PlanDate => ({ y: view().y, m: view().m, d });
              return (
                <button
                  type="button"
                  class="planner-day"
                  classList={{
                    today: sameDate(date(), today),
                    planned: plans.some((p) => sameDate(p, date())),
                    cursor: sameDate(date(), cursor()),
                  }}
                  disabled={out(date())}
                  aria-label={new Date(view().y, view().m - 1, d).toLocaleDateString('ru', { weekday: 'long', day: 'numeric', month: 'long' })}
                  aria-pressed={plans.some((p) => sameDate(p, date()))}
                  onClick={() => pick(date())}
                >
                  {d}
                </button>
              );
            }}
          </For>
        </div>
        <Show when={plans.length}>
          <div class="menu-sep" role="separator" />
          <button type="button" class="planner-cancel destructive" onClick={cancel}>
            Отменить планирование
          </button>
        </Show>
      </div>
    </>
  );
}
