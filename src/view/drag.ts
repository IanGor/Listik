import { createSignal, type Accessor } from 'solid-js';
import { moveManyTo } from '../model/commands';
import type { RowKey } from '../model/rows';
import { indentation } from './indent';
import type { Outliner } from './outliner';

/** Where a drop would land (rows: under a mirror row, into its original), and the line that shows it (px, relative to the spacer). */
export interface DropTarget {
  parent: RowKey;
  after: RowKey | null;
  top: number;
  left: number;
}

interface Elements {
  scroller: HTMLElement;
  spacer: HTMLElement;
  windowEl: HTMLElement;
  indentProbe: HTMLElement;
}

/** Pointer travel that turns a press on a bullet into a drag; less is a click (zoom in). */
const THRESHOLD = 4;
/** A finger held this long on a bullet picks it up, ms. */
const LONG_PRESS = 350;
/** A finger that travels this far before that scrolls or swipes instead, px. */
const TOUCH_SLOP = 8;
/** Distance from the scroller's edge where a drag scrolls the list, px. */
const EDGE = 48;

/**
 * Dragging bullets by their dot. A press that does not move is a click and
 * zooms in. A drag moves the bullet, or the whole selection if the bullet is
 * part of it; the drop line shows the place and the level, which follows the
 * pointer's x within what is allowed there.
 *
 * A finger works the same way except how a drag starts: the finger is held
 * still for LONG_PRESS first, and lifted without moving after that, it opens
 * the row's menu of actions (RowMenu.tsx) instead, as a long press does on
 * an iPhone or iPad. Moving sooner is a scroll (the bullet allows
 * vertical panning, index.css), and the browser then cancels the pointer.
 * Once picked up, Row.tsx stops the panning, so the finger moves the bullet.
 *
 * A finger can also pick a row up by its text (`from` 'row'): held still
 * there, the row lights up and then is picked up the same way. Until then
 * the press is left to the browser, so a tap still edits, a move still
 * scrolls or swipes (swipe.ts), and a tap is never a zoom.
 */
export function createDrag(o: Outliner, el: () => Elements) {
  const [target, setTarget] = createSignal<DropTarget | null>(null);

  function start(e: PointerEvent, id: RowKey, from: 'bullet' | 'row' = 'bullet'): void {
    if (e.button !== 0) return;
    const byRow = from === 'row';
    if (byRow && e.pointerType !== 'touch') return;
    const handle = e.currentTarget as HTMLElement;
    if (!byRow) {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
    }
    // Held on the row: it lights up as the hold goes on, and the browser's own long press (selecting a word) stays out.
    const row = byRow ? handle : null;
    row?.classList.add('holding');
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let ids: RowKey[] = [];
    /** Rows of the dragged subtrees, which cannot take a drop. */
    let inside = new Set<RowKey>();
    let pointer = { x: startX, y: startY };
    /** Where a finger picked the row up, and whether it has moved off since: lifted in place, the row's menu opens. */
    let lifted = { x: startX, y: startY };
    let strayed = false;
    let scrollFrame = 0;
    const finger = e.pointerType === 'touch';
    const hold = finger
      ? window.setTimeout(() => {
          lifted = pointer;
          begin();
          navigator.vibrate?.(10);
          setTarget(locate());
        }, LONG_PRESS)
      : 0;

    const begin = () => {
      dragging = true;
      const selected = o.selectedSet();
      ids = selected.has(id) ? o.selectionRoots() : [id];
      inside = new Set();
      for (const root of ids) {
        const i = o.rows.indexOf(root);
        if (i < 0) continue;
        for (let j = i, end = o.rows.subtreeEnd(i); j < end; j++) inside.add(o.rows.ids[j]);
      }
      o.setDragged(inside);
      document.body.classList.add('is-dragging');
      autoScroll();
    };

    const locate = (): DropTarget | null => {
      const { spacer, windowEl, indentProbe } = el();
      const row = document.elementFromPoint(pointer.x, pointer.y)?.closest<HTMLElement>('.row') ?? null;
      const rows = o.rows;
      let prev: number;
      let rowEl: HTMLElement | null = row;
      if (row) {
        const i = rows.indexOf(row.dataset.id!);
        if (i < 0) return null;
        const r = row.getBoundingClientRect();
        prev = pointer.y < r.top + r.height / 2 ? i - 1 : i;
      } else {
        // Below the last row: after it.
        const last = windowEl.lastElementChild as HTMLElement | null;
        if (!last || pointer.y < last.getBoundingClientRect().bottom) return null;
        prev = rows.length - 1;
        rowEl = last;
      }
      const prevId = prev >= 0 ? rows.ids[prev] : null;
      const nextId = prev + 1 < rows.length ? rows.ids[prev + 1] : null;
      // Between two rows of a dragged subtree: nowhere to go.
      if (prevId && nextId && inside.has(prevId) && inside.has(nextId)) return null;

      // The level: from the pointer's x, between the next row's depth and one deeper than the previous row.
      const indent = indentation(indentProbe);
      const base = windowEl.getBoundingClientRect().left;
      const maxDepth = prevId ? rows.depths[prev] + 1 : 0;
      const minDepth = nextId ? rows.depths[prev + 1] : 0;
      const depth = Math.max(minDepth, Math.min(maxDepth, indent.levelAt(pointer.x - base)));

      let parent: RowKey;
      let after: RowKey | null;
      if (!prevId) {
        parent = rows.top;
        after = null;
      } else if (depth === rows.depths[prev] + 1) {
        parent = prevId;
        after = null;
      } else {
        let node = prevId;
        for (let d = rows.depths[prev]; d > depth; d--) node = rows.parentKey(node)!;
        parent = rows.parentKey(node) ?? rows.top;
        after = node;
      }
      // Never into a dragged subtree.
      for (let p: RowKey | null = parent; p !== null && p !== rows.top; p = rows.parentKey(p)) {
        if (inside.has(p)) return null;
      }

      const spacerRect = spacer.getBoundingClientRect();
      const anchor = prevId ? (rowEl?.dataset.id === prevId ? rowEl : spacer.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(prevId)}"]`)) : null;
      const top = anchor
        ? anchor.getBoundingClientRect().bottom - spacerRect.top
        : (rowEl?.getBoundingClientRect().top ?? spacerRect.top) - spacerRect.top;
      return { parent, after, top, left: base - spacerRect.left + indent.at(depth) };
    };

    const autoScroll = () => {
      const { scroller } = el();
      const r = scroller.getBoundingClientRect();
      const speed = pointer.y < r.top + EDGE ? -(r.top + EDGE - pointer.y) : pointer.y > r.bottom - EDGE ? pointer.y - (r.bottom - EDGE) : 0;
      if (speed) {
        scroller.scrollTop += speed / 3;
        setTarget(locate());
      }
      scrollFrame = requestAnimationFrame(autoScroll);
    };

    const onMove = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (dragging && Math.hypot(pointer.x - lifted.x, pointer.y - lifted.y) > TOUCH_SLOP) strayed = true;
      if (!dragging) {
        const travel = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        // A finger on the move before the hold is up: not a press at all.
        if (finger) return void (travel > TOUCH_SLOP && finish(false));
        if (travel < THRESHOLD) return;
        begin();
      }
      setTarget(locate());
    };

    const finish = (drop: boolean) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      clearTimeout(hold);
      cancelAnimationFrame(scrollFrame);
      row?.classList.remove('holding');
      const t = target();
      setTarget(null);
      o.setDragged(new Set<RowKey>());
      document.body.classList.remove('is-dragging');
      if (!dragging) {
        if (drop && !byRow) o.pressBullet(id);
        return;
      }
      // Picked up by a finger and let go where it was: not a move but a wish to act on it (Apple's long press).
      if (drop && finger && !strayed) return o.openRowMenu(id, pointer.x, pointer.y);
      if (drop && t) o.run((ctx) => moveManyTo(ctx, ids, t.parent, t.after));
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  return { start, target: target as Accessor<DropTarget | null> };
}
