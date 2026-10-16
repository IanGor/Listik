import { For, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { onGlobalKeys } from './keymap';
import type { Outliner } from './outliner';
import { Row } from './Row';
import { TopBar } from './TopBar';
import { Virtualizer } from './virtualizer';

/** Space above the first and below the last row, px. */
const PAD = 32;
/** Rows rendered beyond the viewport on each side, px. */
const OVERSCAN = 600;
/** Vertical padding of `.row`, px. */
const ROW_PAD = 6;

/**
 * The scrollable outline. Only rows near the viewport are in the DOM; they
 * flow normally inside a "window" shifted to the first rendered row's offset,
 * so estimate errors never make rows overlap.
 */
export function Outline(props: { o: Outliner }) {
  const o = props.o;
  let scroller!: HTMLDivElement;
  let windowEl!: HTMLDivElement;
  let probe!: HTMLSpanElement;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [layout, bumpLayout] = createSignal(undefined, { equals: false });

  const v = new Virtualizer(o.rows, () => 24);
  onCleanup(() => v.dispose());

  const range = createMemo(() => {
    o.rowsVersion();
    layout();
    return v.range(scrollTop() - PAD, viewport(), OVERSCAN);
  });
  const ids = createMemo(() => {
    const [start, end] = range();
    return o.rows.ids.slice(start, end);
  });
  const total = createMemo(() => {
    o.rowsVersion();
    layout();
    return v.total;
  });

  const rowObserver = new ResizeObserver((entries) => {
    const [start] = range();
    const current = ids();
    let changed = false;
    let anchor = 0;
    for (const entry of entries) {
      const k = current.indexOf((entry.target as HTMLElement).dataset.id!);
      if (k < 0) continue;
      const i = start + k;
      const top = v.offsetOf(i) + PAD;
      const d = v.measure(i, entry.borderBoxSize[0].blockSize);
      if (!d) continue;
      changed = true;
      // A row above the viewport changed height: shift so the visible content stays put.
      if (top < scroller.scrollTop) anchor += d;
    }
    if (anchor) scroller.scrollTop += anchor;
    if (changed) bumpLayout();
  });
  onCleanup(() => rowObserver.disconnect());

  const observe = (el: HTMLElement) => {
    rowObserver.observe(el);
    return () => rowObserver.unobserve(el);
  };

  /** Monospace makes the estimate nearly exact: characters per line are known. */
  const updateMetrics = () => {
    const ch = probe.getBoundingClientRect().width / 10;
    const lh = parseFloat(getComputedStyle(windowEl).lineHeight) || 20;
    const cols = Math.max(20, Math.floor(windowEl.clientWidth / ch));
    v.setEstimate((id, depth) => {
      const len = o.doc.nodes.get(id)?.text.length ?? 0;
      const perLine = Math.max(10, cols - 2 * depth - 2); // --indent is 2ch; bullet + gap is 2ch
      return Math.max(1, Math.ceil(len / perLine)) * lh + ROW_PAD;
    });
    const [start] = range();
    Array.from(windowEl.children).forEach((el, k) => v.measure(start + k, el.getBoundingClientRect().height));
    setViewport(scroller.clientHeight);
    bumpLayout();
  };

  onMount(() => {
    updateMetrics();
    let width = scroller.clientWidth;
    const resize = new ResizeObserver(() => {
      setViewport(scroller.clientHeight);
      if (scroller.clientWidth === width) return;
      width = scroller.clientWidth;
      updateMetrics();
    });
    resize.observe(scroller);
    onCleanup(() => resize.disconnect());

    // Global keys and Esc also work when no row is being edited; the editing
    // row and the search box handle their own keys.
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.isContentEditable || target.tagName === 'INPUT') return;
      if (e.key === 'Escape' && (o.query() || o.filter())) return o.setQuery('', true);
      onGlobalKeys(e, o);
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  const ensureVisible = (i: number) => {
    const top = v.offsetOf(i) + PAD;
    const bottom = top + v.heightOf(i);
    const st = scroller.scrollTop;
    const vh = scroller.clientHeight;
    let next = st;
    if (top < st) next = top - PAD;
    else if (bottom > st + vh) next = bottom - vh + PAD;
    if (next === st) return;
    scroller.scrollTop = next;
    setScrollTop(scroller.scrollTop);
  };

  // A new search shows its results from the top.
  createEffect(on(o.filter, (f) => {
    if (!f) return;
    scroller.scrollTop = 0;
    setScrollTop(0);
  }, { defer: true }));

  createEffect(() => {
    const f = o.focus();
    if (!f) return;
    const i = o.rows.indexOf(f.id);
    if (i >= 0) ensureVisible(i);
  });

  // A click on the empty space below the rows edits the last one.
  const onMouseDown = (e: MouseEvent) => {
    if (e.target !== scroller && !(e.target as HTMLElement).classList.contains('spacer')) return;
    e.preventDefault();
    const last = o.rows.ids[o.rows.length - 1];
    if (last) o.setFocus({ id: last, caret: o.doc.get(last).text.length });
  };

  return (
    <div class="outline">
      <TopBar o={o} />
      <div ref={scroller} class="scroller" onScroll={() => setScrollTop(scroller.scrollTop)} onMouseDown={onMouseDown}>
        <div class="spacer" style={{ height: `${total() + 2 * PAD}px` }}>
          <span ref={probe} class="probe" aria-hidden="true">0000000000</span>
          <div ref={windowEl} class="window" style={{ transform: `translateY(${PAD + v.offsetOf(range()[0])}px)` }}>
            <For each={ids()}>
              {(id, k) => <Row o={o} id={id} depth={o.rows.depths[range()[0] + k()]} observe={observe} />}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
