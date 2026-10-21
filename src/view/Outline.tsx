import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { appendChild } from '../model/commands';
import { nodeOf, type RowKey } from '../model/rows';
import { Backlinks } from './Backlinks';
import { keyboard, touch } from './screen';
import { createDrag } from './drag';
import { indentation } from './indent';
import { EditBar } from './EditBar';
import { GoTo } from './GoTo';
import { keepSpot, reloaded, takeSpot } from './reload';
import { onGlobalKeys, onSelectionKeys } from './keymap';
import type { Outliner } from './outliner';
import { Row } from './Row';
import { Shortcuts } from './Shortcuts';
import { QuickCapture } from './QuickCapture';
import { Suggest } from './Suggest';
import { Trash } from './Trash';
import { SyncDialog } from './SyncDialog';
import { TopBar } from './TopBar';
import { Crumbs, ZoomTitle } from './ZoomHeader';
import { syncZoomWithHash } from './zoom-hash';
import { textScale } from './textsize';
import { Virtualizer } from './virtualizer';

/** Space above the first and below the last row, px; zoomed in, above the title. */
const PAD = 14;
/** Rows rendered beyond the viewport on each side, px. */
const OVERSCAN = 600;
/** Vertical padding of `.row`, px. */
const ROW_PAD = 4;
/** Line height of a note relative to the text's: 14 px × 1.5 against 17 px × 1.53. */
const NOTE_SCALE = 0.81;
/** Lines of a note shown under a row not being edited (`.note.clamped` in index.css). */
const NOTE_LINES = 3;
/** Width of the bullet and the gap after it, px: `--bullet` plus the `.row` gap. */
const BULLET_GAP = 26;
/** The column kept free at the end of every row for the fold arrow on a touch screen, px (`--fold` in index.css). */
const FOLD_COLUMN = 32;
/** Air kept between the caret's line and the edge it nears, in lines: room for descenders (р, у, д). */
const CARET_ROOM = 0.6;
/** Height of the "+" line under a zoomed-in list, px; matches `.add` in index.css. */
const ADD_HEIGHT = 32;

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
  let indentProbe!: HTMLSpanElement;
  let spacer!: HTMLDivElement;

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  const [layout, bumpLayout] = createSignal(undefined, { equals: false });

  const v = new Virtualizer(o.rows, () => 24);
  onCleanup(() => v.dispose());

  /** Height of the zoomed-in bullet's title, which scrolls with the list above its first row. */
  const [head, setHead] = createSignal(0);
  const headObserver = new ResizeObserver(([entry]) => setHead(entry.borderBoxSize[0].blockSize));
  onCleanup(() => headObserver.disconnect());
  const observeHead = (el: HTMLElement) => {
    headObserver.observe(el);
    setHead(el.getBoundingClientRect().height);
    onCleanup(() => {
      headObserver.unobserve(el);
      setHead(0);
    });
  };
  /** The keyboard is up for the trash's own filter: the trash stays, it is what is typed into. */
  const [trashTyping, setTrashTyping] = createSignal(false);
  /** Height of the backlinks under a zoomed-in list (Backlinks.tsx), measured the same way. */
  const [foot, setFoot] = createSignal(0);
  const footObserver = new ResizeObserver(([entry]) => setFoot(entry.borderBoxSize[0].blockSize));
  onCleanup(() => footObserver.disconnect());
  const observeFoot = (el: HTMLElement) => {
    footObserver.observe(el);
    onCleanup(() => {
      footObserver.unobserve(el);
      setFoot(0);
    });
  };
  /** Where the first row starts in the scrolled area. */
  const top = () => PAD + (o.zoom() ? head() : 0);

  const range = createMemo(() => {
    o.rowsVersion();
    layout();
    return v.range(scrollTop() - top(), viewport(), OVERSCAN);
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
  /** A "+" under the list, home or zoomed in, adds a bullet without the keyboard. */
  const showAdd = () => !o.filter() && !o.readOnly;
  const addBullet = () => o.run((ctx) => appendChild(ctx, o.rows.top));
  const drag = createDrag(o, () => ({ scroller, spacer, windowEl, indentProbe }));

  const rowObserver = new ResizeObserver((entries) => {
    const [start] = range();
    const current = ids();
    let changed = false;
    let anchor = 0;
    for (const entry of entries) {
      const k = current.indexOf((entry.target as HTMLElement).dataset.id!);
      if (k < 0) continue;
      const i = start + k;
      const y = v.offsetOf(i) + top();
      const d = v.measure(i, entry.borderBoxSize[0].blockSize);
      if (!d) continue;
      changed = true;
      // A row above the viewport changed height: shift so the visible content stays put.
      if (y < scroller.scrollTop) anchor += d;
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
    // The indent changes with the viewport (index.css), so it is measured, not assumed.
    const indent = indentation(indentProbe);
    v.setEstimate((id, depth) => {
      const n = o.doc.nodes.has(nodeOf(id)) ? o.contentOf(id) : undefined;
      const perLine = Math.max(10, Math.floor(cols - (indent.at(depth) + BULLET_GAP + (touch() ? FOLD_COLUMN : 0)) / ch));
      const lines = (text: string) => Math.max(1, Math.ceil(text.length / perLine));
      let h = lines(n?.text ?? '') * lh + ROW_PAD;
      // Notes are set smaller (index.css): about NOTE_SCALE of a text line each, NOTE_LINES at most.
      if (n?.note) {
        let shown = 0;
        for (const line of n.note.split('\n')) shown += lines(line);
        h += Math.min(NOTE_LINES, shown) * lh * NOTE_SCALE;
      }
      return h;
    });
    const [start] = range();
    Array.from(windowEl.children).forEach((el, k) => v.measure(start + k, el.getBoundingClientRect().height));
    setViewport(scroller.clientHeight);
    bumpLayout();
  };

  onMount(() => {
    updateMetrics();
    let width = scroller.clientWidth;
    let height = scroller.clientHeight;
    const resize = new ResizeObserver(() => {
      setViewport(scroller.clientHeight);
      // Shorter: on a phone the keyboard came up (index.html makes it shrink
      // the page). The row being edited must stay above it.
      if (scroller.clientHeight < height) {
        const f = o.focus();
        const i = f ? o.rows.indexOf(f.id) : -1;
        if (i >= 0) ensureVisible(i);
        revealCaret();
      }
      height = scroller.clientHeight;
      if (scroller.clientWidth === width) return;
      width = scroller.clientWidth;
      updateMetrics();
    });
    resize.observe(scroller);
    onCleanup(() => resize.disconnect());

    // Global keys and Esc also work when no row is being edited; the editing
    // row and the search box handle their own keys.
    const onKeyDown = (e: KeyboardEvent) => {
      // Quick capture to the Inbox: from anywhere, while editing too (by the physical key: any layout).
      if (e.code === 'Space' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        e.preventDefault();
        return o.openCapture();
      }
      // Go to a place by its name, as in Workflowy: from anywhere, the search box too.
      if (e.code === 'KeyK' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        return o.openGoTo();
      }
      const target = e.target as HTMLElement;
      if (target.isContentEditable || target.tagName === 'INPUT') return;
      if (onSelectionKeys(e, o)) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        return o.showHelp();
      }
      if (e.key === 'Escape' && (o.query() || o.filter())) return o.setQuery('', true);
      if (e.key === 'ArrowLeft' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        return o.zoomOut();
      }
      onGlobalKeys(e, o);
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  const ensureVisible = (i: number) => {
    const y = v.offsetOf(i) + top();
    const bottom = y + v.heightOf(i);
    const st = scroller.scrollTop;
    const vh = scroller.clientHeight;
    let next = st;
    if (y < st) next = y - PAD;
    else if (bottom > st + vh) next = bottom - vh + PAD;
    if (next === st) return;
    scroller.scrollTop = next;
    setScrollTop(scroller.scrollTop);
  };

  /**
   * Keeps the caret's line, descenders and a little air included, clear of
   * the outline's edges: at the bottom that is the editing bar over the
   * keyboard. Runs on every input, as a typed line may wrap onto a new one.
   */
  const revealCaret = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el?.isContentEditable || !scroller.contains(el)) return;
    const sel = getSelection();
    let r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!r?.height) r = el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const room = (parseFloat(getComputedStyle(el).lineHeight) || 24) * CARET_ROOM;
    const below = r.bottom + room - box.bottom;
    const above = box.top - (r.top - room);
    if (below > 0) scroller.scrollTop += below;
    else if (above > 0) scroller.scrollTop -= above;
    else return;
    setScrollTop(scroller.scrollTop);
  };

  /** Room under the last row: half the outline's height, so the end of a list can be worked on mid-screen. */
  const tail = () => Math.max(PAD, Math.round(viewport() / 2));

  // A new text size (menu) changes characters per line and line height.
  createEffect(on(textScale, () => updateMetrics(), { defer: true }));

  // Zooming starts at the top of the new level (zooming out then scrolls to the
  // bullet we left, through the focus effect below).
  createEffect(on(o.zoom, () => {
    scroller.scrollTop = 0;
    setScrollTop(0);
  }, { defer: true }));

  syncZoomWithHash(o);
  // A reload is the same view again: the zoom from the address, the search
  // and the scroll as they were (reload.ts). A new start without a place in
  // the address (the installed app always is): today's day, if there is the structure.
  const again = reloaded();
  const spot = again ? takeSpot() : null;
  const same = spot !== null && spot.zoom === o.zoom();
  if (again) {
    if (same && spot.query) o.setQuery(spot.query, true);
    o.stayedToday();
  } else if (!location.hash) o.goToday(true);
  onMount(() => {
    const row = same ? spot.row : null;
    if (row) requestAnimationFrame(() => {
      const i = o.rows.indexOf(row);
      if (i < 0) return;
      scroller.scrollTop = top() + v.offsetOf(i) + spot!.offset;
      setScrollTop(scroller.scrollTop);
    });
  });
  const onLeave = () => {
    const y = scroller.scrollTop - top();
    const i = v.indexAt(Math.max(0, y));
    const row = o.rows.ids[i] ?? null;
    keepSpot({ zoom: o.zoom(), query: o.query(), row, offset: row ? y - v.offsetOf(i) : 0 });
  };
  addEventListener('pagehide', onLeave);
  onCleanup(() => removeEventListener('pagehide', onLeave));
  const onVisible = () => document.visibilityState === 'visible' && o.resumed();
  document.addEventListener('visibilitychange', onVisible);
  onCleanup(() => document.removeEventListener('visibilitychange', onVisible));
  onCleanup(o.watchMidnight());

  createEffect(on(o.homeRequests, () => {
    scroller.scrollTop = 0;
    setScrollTop(0);
  }, { defer: true }));

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
  /**
   * The guide line under the pointer: the lines of a row's indent are its
   * ancestors' (index.css `.row::before`), one per level, through each
   * ancestor's bullet. Returns that ancestor's row, and where its line runs
   * in the spacer; null off a line. Fair room either side of the 1 px line.
   */
  const guideAt = (e: MouseEvent): { key: RowKey; top: number; height: number; left: number } | null => {
    const row = e.target as HTMLElement;
    if (!row.classList?.contains('row')) return null;
    const depth = Number(row.dataset.depth);
    if (!depth) return null;
    const indent = indentation(indentProbe);
    const half = (parseFloat(getComputedStyle(row).getPropertyValue('--bullet')) || 20) / 2;
    const x = e.clientX - row.getBoundingClientRect().left;
    // The nearest line; past --deep they stand closer (index.css).
    let k = 0;
    for (let d = 1; d < depth; d++) if (Math.abs(x - indent.at(d) - half) < Math.abs(x - indent.at(k) - half)) k = d;
    if (Math.abs(x - (indent.at(k) + half)) > (touch() ? 10 : 5)) return null;
    let key: RowKey | null = row.dataset.id!;
    for (let d = depth; d > k && key; d--) key = o.rows.parentKey(key);
    const i = key ? o.rows.indexOf(key) : -1;
    if (i < 0) return null;
    const from = v.offsetOf(i + 1);
    const to = v.offsetOf(o.rows.subtreeEnd(i));
    return { key: key!, top: top() + from, height: to - from, left: windowEl.offsetLeft + indent.at(k) + half };
  };
  const [hotGuide, setHotGuide] = createSignal<{ key: RowKey; top: number; height: number; left: number } | null>(null);
  const onMouseMove = (e: MouseEvent) => {
    const g = drag.target() ? null : guideAt(e);
    const cur = hotGuide();
    if (g?.key !== cur?.key || g?.top !== cur?.top) setHotGuide(g);
  };

  const onMouseDown = (e: MouseEvent) => {
    // A click on a guide line folds the bullet whose line it is, kept in sight.
    const g = e.button === 0 ? guideAt(e) : null;
    if (g) {
      e.preventDefault();
      setHotGuide(null);
      o.fold(g.key, true);
      const i = o.rows.indexOf(g.key);
      if (i >= 0) ensureVisible(i);
      return;
    }
    if (e.target !== scroller && !(e.target as HTMLElement).classList.contains('spacer')) return;
    e.preventDefault();
    const last = o.rows.ids[o.rows.length - 1];
    if (last) o.setFocus({ id: last, caret: o.contentOf(last).text.length });
  };

  return (
    <div class="outline">
      <TopBar o={o} />
      <Shortcuts o={o} />
      <Show when={o.opened && !o.readOnly}>
        <SyncDialog o={o} />
      </Show>
      <Show when={o.readOnly}>
        <div class="banner" role="status">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          Документ уже открыт в другой вкладке — здесь только просмотр. Закройте ту вкладку, и эта сразу станет редактируемой.
        </div>
      </Show>
      <Show when={o.toast()}>
        {(text) => (
          <div class="toast" role="status">
            {text()}
            <Show when={o.toastLink()}>
              {(link) => (
                <>
                  {' '}
                  <button type="button" class="toast-link" onMouseDown={(e) => e.preventDefault()} onClick={() => link().run()}>
                    {link().label}
                  </button>
                </>
              )}
            </Show>
            <Show when={o.toastAction()}>
              {(action) => (
                <button type="button" class="toast-action" onMouseDown={(e) => e.preventDefault()} onClick={() => action().run()}>
                  {action().label}
                </button>
              )}
            </Show>
          </div>
        )}
      </Show>
      <QuickCapture o={o} />
      <GoTo o={o} />
      <div class="workspace">
        <div class="main">
          <Crumbs o={o} scrolled={scrollTop() > 0} />
          <div ref={scroller} class="scroller" classList={{ 'on-guide': !!hotGuide() }} onScroll={() => setScrollTop(scroller.scrollTop)} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseLeave={() => setHotGuide(null)} onInput={revealCaret}>
            <div ref={spacer} class="spacer" style={{ height: `${top() + total() + tail() + (showAdd() ? ADD_HEIGHT : 0) + foot()}px` }}>
              <span ref={probe} class="probe" aria-hidden="true">0000000000</span>
              <span ref={indentProbe} class="probe indent-probe" aria-hidden="true" />
              <Show when={o.zoom()} keyed>
                {(id) => (
                  <div ref={observeHead} class="zoomhead">
                    <ZoomTitle o={o} id={id} />
                  </div>
                )}
              </Show>
              <div ref={windowEl} class="window" style={{ transform: `translateY(${top() + v.offsetOf(range()[0])}px)` }}>
                <For each={ids()}>
                  {(id, k) => <Row o={o} id={id} depth={o.rows.depths[range()[0] + k()]} observe={observe} grab={drag.start} />}
                </For>
              </div>
              <Show when={drag.target()}>
                {(t) => <div class="drop-line" style={{ top: `${t().top}px`, left: `${t().left}px` }} />}
              </Show>
              {/* The guide line under the pointer, lit through its bullet's whole branch: a click folds it. */}
              <Show when={hotGuide()}>
                {(g) => <div class="guide-hot" style={{ top: `${g().top}px`, height: `${g().height}px`, left: `${g().left}px` }} />}
              </Show>
              {/* A search that finds nothing says so, rather than leaving a blank page. */}
              <Show when={o.filter()?.count === 0}>
                <p class="no-results" role="status" style={{ top: `${top()}px` }}>
                  {o.zoom() ? 'Здесь ничего не найдено' : 'Ничего не найдено'}
                </p>
              </Show>
              <Show when={showAdd()}>
                {/* Sits right under the last row: the rows above it end at `total`. */}
                <button
                  type="button"
                  class="add"
                  style={{ top: `${top() + total()}px` }}
                  title="Новый пункт"
                  aria-label="Новый пункт"
                  onClick={addBullet}
                >
                  <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
                    <path d="M6 1.5v9M1.5 6h9" />
                  </svg>
                </button>
              </Show>
              {/* Under a zoomed-in list (and its "+"): the places that link here, the way back. */}
              <Show when={o.zoom()} keyed>
                {(id) => (
                  <div ref={observeFoot} class="backlinks-slot" style={{ top: `${top() + total() + (showAdd() ? ADD_HEIGHT : 0)}px` }}>
                    <Backlinks o={o} id={id} />
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>
        {/* Beside the outline, not over it: the caret and the work stay there. Out of the way of a phone's keyboard, unless that keyboard types into its filter. */}
        <Show when={o.trashOpen() && (!(touch() && keyboard()) || trashTyping())}>
          <Trash o={o} onTyping={setTrashTyping} />
        </Show>
      </div>
      {/* Its buttons act on the row being edited; not while the keys go to the trash's filter. */}
      <Show when={!trashTyping()}>
        <EditBar o={o} />
      </Show>
      <Suggest o={o} />
    </div>
  );
}
