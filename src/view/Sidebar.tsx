import { FavoriteList } from './FavoriteList';
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { calendarName } from '../model/calendar';
import { titleOf } from '../model/links';
import { navigationRows, navigationSelection, revealNavigation } from './navigation-tree';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';
import { CaptureButton, Places } from './TopBar';
import { touchCapable } from './screen';

function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Optional local preferences. */ } }

export function Sidebar(props: { o: Outliner }) {
  const o = props.o;
  const storage = o.docName ? `listik-navigation:${o.docName}` : null;
  let saved: { expanded?: string[]; scroll?: number } = {};
  try { const value = JSON.parse(storage ? read(storage) ?? '{}' : '{}'); if (value && typeof value === 'object') saved = value; } catch { /* Start folded. */ }
  const [expanded, setExpanded] = createSignal(new Set(Array.isArray(saved.expanded) ? saved.expanded.filter((k) => typeof k === 'string') : []));
  const [open, setOpen] = createSignal(read('listik-navigation-open') === 'true');
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [overlay, setOverlay] = createSignal(false);
  const [version, setVersion] = createSignal(0);
  const [labels, setLabels] = createSignal(0);
  const [scroll, setScroll] = createSignal(Math.max(0, Number(saved.scroll) || 0));
  const [height, setHeight] = createSignal(0);
  const [focused, setFocused] = createSignal<string | null>(null);
  const [preferred, setPreferred] = createSignal<string>();
  let aside!: HTMLElement, scroller!: HTMLDivElement, tree!: HTMLDivElement, toggleButton!: HTMLButtonElement;
  const rowHeight = touchCapable() ? 44 : 34;
  const rows = createMemo(() => { version(); return navigationRows(o.doc, expanded()); });
  const selection = createMemo(() => navigationSelection(rows(), o.doc, o.zoom(), preferred()));
  const start = () => Math.max(0, Math.floor(scroll() / rowHeight) - 8);
  const visible = createMemo(() => rows().slice(start(), start() + Math.ceil(height() / rowHeight) + 16));
  const persist = () => { if (storage) write(storage, JSON.stringify({ expanded: [...expanded()], scroll: scroll() })); };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveScroll = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 150); };
  const setMode = (value: boolean) => {
    setOpen(value); setSearchOpen(false);
    if (!overlay()) write('listik-navigation-open', String(value));
  };
  const collapse = () => { setMode(false); queueMicrotask(() => toggleButton.focus()); };
  const observeScroller = (el: HTMLDivElement) => {
    scroller = el;
    const resize = new ResizeObserver(() => { if (el.clientHeight) setHeight(el.clientHeight); });
    resize.observe(el);
    onCleanup(() => resize.disconnect());
  };
  const fold = (key: string) => {
    const next = new Set(expanded());
    if (next.has(key)) next.delete(key); else next.add(key);
    setExpanded(next); persist();
  };
  const focusRow = (key: string) => {
    setFocused(key);
    const index = rows().findIndex((r) => r.key === key);
    if (index < 0 || !scroller) return;
    const top = index * rowHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rowHeight - scroller.clientHeight;
    setScroll(scroller.scrollTop);
    queueMicrotask(() => tree?.querySelector<HTMLElement>(`[data-nav-index="${index}"]`)?.focus());
  };
  const navigate = (key: string) => {
    const row = rows().find((r) => r.key === key);
    if (!row || !o.doc.inOutline(row.id)) return;
    setPreferred(key); setFocused(key);
    o.setFocus(null); o.zoomTo(row.id);
    if (overlay()) collapse();
  };
  const search = () => { setSearchOpen(true); o.requestSearch(); };
  const treeKeys = (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    const index = rows().findIndex((r) => r.key === focused());
    const row = rows()[Math.max(index, 0)];
    if (!row) return;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ') return navigate(row.key);
    if (e.key === 'ArrowRight') {
      if (row.children && !expanded().has(row.key)) fold(row.key);
      else if (row.children) focusRow(rows()[index + 1]?.key ?? row.key);
    } else if (e.key === 'ArrowLeft') {
      if (expanded().has(row.key)) fold(row.key);
      else if (row.parent) focusRow(row.parent);
    } else {
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows().length - 1 : Math.max(0, Math.min(rows().length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
      focusRow(rows()[next].key);
    }
  };

  onCleanup(o.doc.subscribe({
    commit: (ops) => {
      if (ops.some((op) => ['insert', 'remove', 'move', 'setMirror'].includes(op.t))) setVersion((v) => v + 1);
      if (ops.some((op) => op.t === 'setText')) setLabels((v) => v + 1);
    },
    rollback: () => { setVersion((v) => v + 1); setLabels((v) => v + 1); },
  }));
  createEffect(on(overlay, (over) => {
    const searching = aside?.contains(document.activeElement) && document.activeElement?.matches('input.search');
    setOpen(over ? false : read('listik-navigation-open') === 'true');
    setSearchOpen(!!searching);
    if (searching) queueMicrotask(() => o.requestSearch());
  }, { defer: true }));
  createEffect(on(o.zoom, (id) => {
    if (id && !rows().some((r) => r.key === preferred() && o.doc.origin(r.id) === id)) {
      setExpanded(revealNavigation(o.doc, id, expanded()));
    }
    persist();
  }));
  createEffect(() => {
    const list = rows();
    if (!list.some((r) => r.key === focused())) setFocused(selection() ?? list[0]?.key ?? null);
    const maximum = Math.max(0, list.length * rowHeight - height());
    if (scroll() > maximum) { setScroll(maximum); if (scroller) scroller.scrollTop = maximum; }
  });
  createEffect(() => {
    if (open()) queueMicrotask(() => { if (scroller) scroller.scrollTop = scroll(); });
  });

  onMount(() => {
    const workspace = aside.parentElement!;
    const measure = () => {
      // Leave enough room for the editor, even with the trash or sketch open.
      const extras = workspace.querySelector('.trash')?.getBoundingClientRect().width ?? 0;
      const sketch = workspace.querySelector('.sketch')?.getBoundingClientRect().width ?? 0;
      setOverlay(workspace.clientWidth - extras - sketch < 1020);
      if (scroller?.clientHeight) setHeight(scroller.clientHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace); observer.observe(aside);
    if (scroller) observer.observe(scroller);
    const mutation = new MutationObserver(measure);
    mutation.observe(workspace, { childList: true });
    const desk = workspace.querySelector('.desk');
    if (desk) mutation.observe(desk, { childList: true });
    mutation.observe(aside, { attributes: true, attributeFilter: ['class'] });
    const outside = (e: PointerEvent) => {
      if (aside.contains(e.target as Node)) return;
      if (searchOpen()) setSearchOpen(false);
      if (overlay() && open()) setMode(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen() || (overlay() && open())) {
        e.preventDefault(); e.stopPropagation();
        if ((e.target as HTMLElement).matches('input.search')) o.setQuery('', true);
        setSearchOpen(false);
        if (overlay()) collapse(); else toggleButton.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    onCleanup(() => { clearTimeout(saveTimer); persist(); observer.disconnect(); mutation.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); });
    measure();
  });

  return (
    <aside ref={aside} class="navigation-sidebar" classList={{ expanded: open(), overlay: overlay(), 'search-visible': searchOpen(), 'touch-navigation': touchCapable() }} aria-label="Навигация по документу">
      <div class="navigation-surface">
        <div class="navigation-head">
          <button ref={toggleButton} class="navigation-toggle icon-button" type="button" aria-label={open() ? 'Свернуть панель навигации' : 'Открыть панель навигации'} aria-expanded={open()} onClick={() => setMode(!open())} title={open() ? 'Свернуть панель' : 'Открыть панель'}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4" /><path d="M9 4v16M5.8 8h.4M5.8 12h.4" stroke-linecap="round" /></svg>
          </button>
          <span class="navigation-heading">Навигация</span>
        </div>
        <div class="navigation-actions">
          <Places o={o} onNavigate={() => { if (overlay()) collapse(); }} />
          <button class="navigation-search-button place" type="button" aria-label="Поиск" title="Поиск в текущей ветке" onClick={search}>
            <svg class="place-icon" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" stroke-linecap="round" /></svg><span class="place-label">Поиск</span>
          </button>
          <div class="navigation-capture"><CaptureButton o={o} labelled /></div>
        </div>
        <div class="navigation-search" classList={{ visible: open() || searchOpen() }}>
          <SearchBar o={o} onRequest={() => { if (!open()) setSearchOpen(true); }} />
        </div>
        <Show when={open()}>
          <FavoriteList o={o} labelVersion={labels} navigate={(id) => {
            o.setFocus(null); o.zoomTo(id);
            if (overlay()) collapse();
          }} search={(query) => { o.setQuery(query, true); o.requestSearch(); }} />
          <div class="navigation-tree-heading">
            <span class="navigation-section-label" aria-hidden="true">Дерево документа</span>
            <button class="navigation-collapse-all" type="button" aria-label="Свернуть дерево" title="Свернуть дерево" disabled={!rows().some((row) => row.children && expanded().has(row.key))}
              onClick={() => { setExpanded(new Set<string>()); setScroll(0); if (scroller) scroller.scrollTop = 0; persist(); }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 4 4 4-4M6 17l4-4 4 4" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </button>
          </div>
          <div ref={observeScroller} class="navigation-scroll" onScroll={(e) => { setScroll(e.currentTarget.scrollTop); saveScroll(); }}>
            <div ref={tree} class="navigation-tree" role="tree" aria-label="Дерево документа" onKeyDown={treeKeys} style={{ height: `${rows().length * rowHeight}px` }}>
              <For each={visible()}>{(row) => {
                const index = () => start() + visible().indexOf(row);
                const label = () => { labels(); return calendarName(o.doc, o.doc.origin(row.id), 'crumb') ?? (titleOf(o.doc.content(row.id).text) || 'Без названия'); };
                return <div class="navigation-row" role="treeitem" data-nav-key={row.key} data-nav-index={index()} aria-label={label()} aria-level={row.depth + 1} aria-posinset={row.position} aria-setsize={row.siblings} aria-expanded={row.children ? expanded().has(row.key) : undefined} aria-selected={selection() === row.key} tabIndex={focused() === row.key ? 0 : -1} style={{ top: `${index() * rowHeight}px`, height: `${rowHeight}px`, 'padding-left': `${8 + Math.min(row.depth, 8) * 14}px` }} onFocus={() => setFocused(row.key)} onClick={() => navigate(row.key)} title={label()}>
                  <Show when={row.children} fallback={<span class="navigation-leaf" aria-hidden="true" />}>
                    <button class="navigation-disclosure" type="button" tabIndex={-1} aria-label={`${expanded().has(row.key) ? 'Свернуть' : 'Развернуть'} ${label()}`} onClick={(e) => { e.stopPropagation(); setFocused(row.key); fold(row.key); }}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" classList={{ turned: expanded().has(row.key) }} aria-hidden="true"><path d="m6 4 4 4-4 4" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    </button>
                  </Show>
                  <Show when={o.doc.get(row.id).mirrorOf}><span class="navigation-mirror" aria-label="Зеркало">◇</span></Show>
                  <span class="navigation-title">{label()}</span>
                </div>;
              }}</For>
            </div>
            <Show when={!rows().length}><p class="navigation-empty">Документ пуст</p></Show>
          </div>
        </Show>
      </div>
    </aside>
  );
}
