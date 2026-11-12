import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Outline } from './Outline';
import type { Outliner } from './outliner';
import { SplitContext } from './split-context';

interface PaneState {
  zoom: string | null;
  query: string;
  scroll: number;
  folds: [string, boolean][];
  mirrors: [string, boolean][];
}
interface SavedSplit { version: 1; active: 0 | 1; ratio: number; panes: [PaneState, PaneState] }

/** A document session has one writer and at most two lightweight editor views. */
export function SplitWorkspace(props: { o: Outliner }) {
  const first = props.o;
  const key = `listik-split:${first.docName ?? location.search}`;
  const [second, setSecond] = createSignal<Outliner | null>(null);
  const [enabled, setEnabled] = createSignal(false);
  const [active, setActive] = createSignal<0 | 1>(0);
  const [ratio, setRatio] = createSignal(50);
  const media = matchMedia('(min-width: 1024px)');
  const [wide, setWide] = createSignal(media.matches);
  let root!: HTMLDivElement;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let dragging = false;
  const view = (index: number) => index === 0 ? first : second()!;
  const activate = (index: 0 | 1) => {
    if (index === active()) return;
    const old = view(active());
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root?.querySelector(`[data-pane="${active()}"]`)?.contains(focused)) focused.blur();
    // Input is committed on every keystroke. Drop only the old editing/focus
    // state, never its zoom, query, folds or scroll position.
    old.editTitle(null);
    old.setFocus(null);
    old.select(null);
    old.history.breakTyping();
    setActive(index);
  };
  const current = () => view(active());
  const capture = (o: Outliner): PaneState => ({
    zoom: o.zoom(), query: o.query(), scroll: o.paneScroll,
    folds: o.rows.paneFoldEntries(), mirrors: o.rows.foldEntries(),
  });
  const restore = (o: Outliner, state: PaneState) => {
    o.paneManaged = true;
    o.rows.isolateFolds(state.folds);
    o.rows.loadFolds(state.mirrors);
    o.zoomTo(state.zoom && o.doc.has(state.zoom) && o.doc.inOutline(state.zoom) ? state.zoom : null);
    o.setQuery(state.query, true);
    o.paneScroll = state.scroll;
    o.refreshView();
  };
  const save = () => {
    clearTimeout(saveTimer);
    try {
      if (!enabled() || !second()) { localStorage.removeItem(key); return; }
      const panes = [first, second()!] as const;
      for (let i = 0; i < panes.length; i++) {
        const scroller = root?.querySelector<HTMLElement>(`[data-pane="${i}"] .scroller`);
        if (scroller?.getClientRects().length) panes[i].paneScroll = scroller.scrollTop;
      }
      const state: SavedSplit = { version: 1, active: active(), ratio: ratio(), panes: [capture(first), capture(second()!)] };
      localStorage.setItem(key, JSON.stringify(state));
    } catch { /* Optional local view preferences must never block editing. */ }
  };
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 200); };
  const toggle = () => {
    if (enabled()) {
      current().editTitle(null);
      current().setFocus(null);
      current().rows.releasePaneFolds(!current().readOnly);
      const other = view(active() === 0 ? 1 : 0);
      other.rows.releasePaneFolds();
      current().refreshView(); other.refreshView();
      current().paneManaged = false;
      setEnabled(false);
      save();
      return;
    }
    if (!wide()) return;
    const source = current();
    source.editTitle(null);
    source.setFocus(null);
    source.rows.isolateFolds(source.rows.independentFolds ? source.rows.paneFoldEntries() : undefined);
    source.paneManaged = true;
    source.refreshView();
    const scroller = root.querySelector<HTMLElement>(`[data-pane="${active()}"] .scroller`);
    if (scroller) source.paneScroll = scroller.scrollTop;
    let peer = second();
    if (!peer) { peer = first.forkView(); setSecond(peer); }
    const targetIndex = active() === 0 ? 1 : 0;
    const target = view(targetIndex);
    restore(target, capture(source));
    // Preserve both mounted scrollers when reopening a split.
    queueMicrotask(() => {
      const el = root.querySelector<HTMLElement>(`[data-pane="${targetIndex}"] .scroller`);
      if (el) el.scrollTop = source.paneScroll;
    });
    setRatio(50);
    setEnabled(true);
    activate(targetIndex);
    scheduleSave();
  };

  // A stale or damaged preference cannot prevent opening the document.
  try {
    const saved: SavedSplit = JSON.parse(localStorage.getItem(key) ?? 'null');
    const entries = (value: unknown): value is [string, boolean][] => Array.isArray(value) && value.length <= first.doc.nodes.size * 4 && value.every(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'boolean');
    const valid = (p: PaneState) => p && (p.zoom === null || typeof p.zoom === 'string') && typeof p.query === 'string' && p.query.length <= 10000 && Number.isFinite(p.scroll) && p.scroll >= 0 && entries(p.folds) && entries(p.mirrors);
    if (saved?.version === 1 && Array.isArray(saved.panes) && saved.panes.length === 2 && saved.panes.every(valid)) {
      const peer = first.forkView();
      restore(first, saved.panes[0]); restore(peer, saved.panes[1]);
      setSecond(peer); setActive(saved.active === 1 ? 1 : 0);
      setRatio(Number.isFinite(saved.ratio) ? Math.max(32, Math.min(68, saved.ratio)) : 50);
      setEnabled(true);
      const hash = /^#\/(.+)$/.exec(location.hash);
      if (hash) {
        const id = decodeURIComponent(hash[1]);
        if (first.doc.has(id) && id !== current().zoom()) current().zoomTo(id);
      }
    }
  } catch { /* Ignore invalid local state. */ }

  createEffect(() => {
    enabled(); active(); ratio(); first.zoom(); first.query(); first.rowsVersion();
    const peer = second(); peer?.zoom(); peer?.query(); peer?.rowsVersion();
    scheduleSave();
  });
  onMount(() => {
    const resized = () => { setWide(media.matches); scheduleSave(); };
    const hidden = () => { if (document.visibilityState === 'hidden') save(); };
    const fromEvent = (event: Event) => {
      const pane = (event.target as Element).closest<HTMLElement>('[data-pane]');
      if (pane && root.contains(pane)) activate(pane.dataset.pane === '1' ? 1 : 0);
    };
    root.addEventListener('pointerdown', fromEvent, true);
    root.addEventListener('focusin', fromEvent, true);
    root.addEventListener('scroll', scheduleSave, true);
    media.addEventListener('change', resized);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', hidden);
    onCleanup(() => {
      clearTimeout(saveTimer);
      root.removeEventListener('pointerdown', fromEvent, true);
      root.removeEventListener('focusin', fromEvent, true);
      root.removeEventListener('scroll', scheduleSave, true);
      media.removeEventListener('change', resized);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', hidden);
      second()?.disposeView();
    });
  });
  const moveDivider = (clientX: number) => {
    const box = root.getBoundingClientRect();
    setRatio(Math.max(32, Math.min(68, (clientX - box.x) / box.width * 100)));
  };
  const hidden = (index: 0 | 1) => (!enabled() || !wide()) && active() !== index;
  return <SplitContext.Provider value={{ enabled, wide, toggle, active: o => o === current() }}>
    <div ref={root} class="split-workspace" classList={{ 'split-enabled': enabled(), 'split-wide': wide() }}>
      <section class="split-pane" classList={{ active: active() === 0 }} hidden={hidden(0)} data-pane="0"
        aria-label="Левая область документа" style={{ flex: `${ratio()} 1 0%` }}>
        <Outline o={first} />
      </section>
      <Show when={second()} keyed>{peer => <>
        <div class="split-divider" hidden={!enabled() || !wide()} role="separator" aria-label="Ширина областей" aria-orientation="vertical"
          aria-valuemin={32} aria-valuemax={68} aria-valuenow={Math.round(ratio())} tabIndex={0}
          onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); dragging = true; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if (dragging) moveDivider(e.clientX); }}
          onPointerUp={e => { dragging = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); scheduleSave(); }}
          onPointerCancel={() => { dragging = false; }}
          onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); setRatio(e.key === 'Home' ? 32 : e.key === 'End' ? 68 : Math.max(32, Math.min(68, ratio() + (e.key === 'ArrowLeft' ? -2 : 2)))); }} />
        <section class="split-pane" classList={{ active: active() === 1 }} hidden={hidden(1)} data-pane="1"
          aria-label="Правая область документа" style={{ flex: `${100 - ratio()} 1 0%` }}>
          <Outline o={peer} secondary />
        </section>
      </>}</Show>
    </div>
  </SplitContext.Provider>;
}
