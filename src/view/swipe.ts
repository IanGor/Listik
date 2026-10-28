import type { RowKey } from '../model/rows';
import type { Outliner } from './outliner';
import { tablet } from './screen';

/**
 * A finger swiping a row sideways: to the left the bullet goes to the trash
 * with all it holds (the toast can take it back), to the right the calendar
 * opens to plan it for a day (`Outliner.swipePlan`; a task is checked from
 * the keyboard or its checkbox). A bullet that cannot be planned (the
 * calendar, a secret) does not move to the right. One movement: the row's content follows the finger over a
 * backing that says what will happen; let go past THRESHOLD of the row's
 * width (or flicked past FLICK), it happens, back under it nothing does.
 *
 * Up and down is the list's scrolling: the direction is decided once, after
 * SLOP px. Not from the bullet (a hold there drags, drag.ts), not in the row
 * being edited (the finger moves the caret there), not within EDGE px of the
 * screen's sides (the system's back gesture).
 */

const SLOP = 10;
/** Sideways enough: |dx| at least this many times |dy|. */
const SIDEWAYS = 1.5;
/** Of the row's width: past it, letting go does it. */
const THRESHOLD = 0.4;
/** A quick flick does it from this share of the row's width. */
const FLICK = 0.25;
/** px/ms */
const FLICK_SPEED = 0.5;
const EDGE = 24;
/** A finger held this long before it moves is selecting text, not swiping. */
const HOLD = 400;
/** The row sliding back or away, ms (index.css: .row.settling). */
const SETTLE = 150;
/** A swipe's own tap (compatibility mouse events) is not a click on what is under it. */
const SWALLOW = 400;

// The icons shared with the editing bar (EditBar.tsx) and the row menu: delete and the calendar.
const TRASH = ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'];
export const CALENDAR = ['M4 8.5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z', 'M4 10h16', 'M8 3v3.5', 'M16 3v3.5'];

/** Lets the row be swiped (not on a tablet: it has the computer's controls); returns the function that stops it. */
export function swipe(o: Outliner, row: HTMLElement, key: RowKey, editing: () => boolean): () => void {
  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || tablet() || !e.isPrimary || o.readOnly || editing() || o.dragged().size) return;
    if (row.classList.contains('settling') || (e.target as Element).closest('.bullet')) return;
    if (e.clientX < EDGE || e.clientX > innerWidth - EDGE) return;
    track(e);
  };
  row.addEventListener('pointerdown', down);
  return () => row.removeEventListener('pointerdown', down);

  function track(e: PointerEvent): void {
    const pointer = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const t0 = e.timeStamp;
    let swiping = false;
    let width = 0;
    let dx = 0;
    let armed = false;
    let back: HTMLElement | null = null;
    let last = { x: x0, t: t0 };
    let speed = 0;
    const plan = o.planOf(key);

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      const mx = ev.clientX - x0;
      const my = ev.clientY - y0;
      if (!swiping) {
        // Held long enough to be picked up (drag.ts): the finger moves the row, not its content.
        if (o.dragged().size) return stop();
        if (Math.hypot(mx, my) < SLOP) return;
        if (ev.timeStamp - t0 > HOLD || Math.abs(mx) < SIDEWAYS * Math.abs(my) || editing()) return stop();
        swiping = true;
        width = row.clientWidth;
        row.setPointerCapture(pointer);
        row.classList.add('swiping');
      }
      if (ev.timeStamp > last.t) speed = (ev.clientX - last.x) / (ev.timeStamp - last.t);
      last = { x: ev.clientX, t: ev.timeStamp };
      dx = Math.max(-width, Math.min(plan === null ? 0 : width, mx));
      show();
    };

    const show = () => {
      // Nothing to the right for a bullet that cannot be planned: no backing either.
      if (dx >= 0 && plan === null) {
        back?.remove();
        back = null;
        row.style.setProperty('--swipe', '0px');
        return;
      }
      const side = dx < 0 ? 'left' : 'right';
      if (back?.dataset.side !== side) {
        back?.remove();
        armed = false;
        back = backing(side, side === 'left' ? 'Удалить' : 'Запланировать', side === 'left' ? TRASH : CALENDAR);
        row.append(back);
      }
      row.style.setProperty('--swipe', `${dx}px`);
      const past = Math.abs(dx) >= THRESHOLD * width;
      if (past !== armed) {
        armed = past;
        back.classList.toggle('armed', armed);
        if (armed) navigator.vibrate?.(10);
      }
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      stop();
      if (!swiping) return;
      swallowClicks();
      const flick = Math.abs(dx) >= FLICK * width && Math.abs(speed) >= FLICK_SPEED && Math.sign(speed) === Math.sign(dx);
      if (dx < 0 && (armed || flick)) {
        return settle(-width, () => {
          o.swipeDelete(key);
          clear();
        });
      }
      if (dx > 0 && (armed || flick)) o.swipePlan(key, row.getBoundingClientRect());
      settle(0, clear);
    };

    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      stop();
      if (swiping) settle(0, clear);
    };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };

    const settle = (to: number, then: () => void) => {
      row.classList.add('settling');
      row.style.setProperty('--swipe', `${to}px`);
      setTimeout(then, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SETTLE);
    };

    const clear = () => {
      row.classList.remove('swiping', 'settling');
      row.style.removeProperty('--swipe');
      back?.remove();
      back = null;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }
}

/** What shows in the room the row's content leaves: the action's icon and word. */
function backing(side: 'left' | 'right', label: string, icon: string[]): HTMLElement {
  const el = document.createElement('div');
  el.className = `swipe-back ${side}`;
  el.dataset.side = side;
  el.setAttribute('aria-hidden', 'true');
  const paths = icon.map((d) => `<path d="${d}"/>`).join('');
  el.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg><span>${label}</span>`;
  return el;
}

/** The click (and mousedown) a touch would get after the finger lifts: not taken as a tap. */
function swallowClicks(): void {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, true);
  window.addEventListener('mousedown', swallow, true);
  setTimeout(() => {
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('mousedown', swallow, true);
  }, SWALLOW);
}
