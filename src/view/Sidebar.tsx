import { SidebarCalendar } from './SidebarCalendar';
import { FavoriteList } from './FavoriteList';
import { Show, createEffect, createSignal, on, onCleanup, onMount, type Accessor } from 'solid-js';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';
import { narrow, touchCapable } from './screen';

function read(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Optional local preferences. */ } }

export function Sidebar(props: { o: Outliner; requests: Accessor<number>; onOpenChange: (open: boolean) => void; active?: Accessor<boolean>; navigationId?: string }) {
  const o = props.o;
  const [open, setOpen] = createSignal(!narrow() && read('listik-navigation-open') === 'true');
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [overlay, setOverlay] = createSignal(narrow());
  const [labels, setLabels] = createSignal(0);
  let aside!: HTMLElement;
  const toggle = () => aside.closest('.outline')?.querySelector<HTMLButtonElement>('[data-action="navigation.open"]');
  const setMode = (value: boolean) => {
    setOpen(value); setSearchOpen(false);
    if (!overlay()) write('listik-navigation-open', String(value));
  };
  const collapse = () => { setMode(false); queueMicrotask(() => toggle()?.focus()); };
  createEffect(() => props.onOpenChange(open()));
  createEffect(on(props.requests, () => open() ? collapse() : setMode(true), { defer: true }));
  createEffect(on(narrow, (compact) => {
    const searching = !!aside?.contains(document.activeElement) && document.activeElement?.matches('input.search');
    setOpen(!!searching || (!compact && !overlay() && read('listik-navigation-open') === 'true'));
    setSearchOpen(!!searching);
  }, { defer: true }));
  onCleanup(o.doc.subscribe({
    commit: () => setLabels(v => v + 1),
    rollback: () => setLabels(v => v + 1),
  }));
  createEffect(on(overlay, (over) => {
    const searching = aside?.contains(document.activeElement) && document.activeElement?.matches('input.search');
    setOpen(over ? !!searching : read('listik-navigation-open') === 'true');
    setSearchOpen(!!searching);
    if (searching) queueMicrotask(() => o.requestSearch());
  }, { defer: true }));
  onMount(() => {
    const workspace = aside.parentElement!;
    const measure = () => {
      // Reserve panel budgets from the window, not their current flex widths:
      // measuring an overlay's effect on its own breakpoint can oscillate.
      const extras = workspace.querySelector('.trash') && !narrow() ? 290 : 0;
      const sketch = workspace.querySelector('.sketch') && workspace.clientWidth >= 1024 ? 400 : 0;
      setOverlay(narrow() || workspace.clientWidth - extras - sketch < 1024);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace); observer.observe(aside);
    const mutation = new MutationObserver(measure);
    mutation.observe(workspace, { childList: true });
    const desk = workspace.querySelector('.desk');
    if (desk) mutation.observe(desk, { childList: true });
    mutation.observe(aside, { attributes: true, attributeFilter: ['class'] });
    const outside = (e: PointerEvent) => {
      if (props.active?.() === false || o.captureOpen()) return;
      if (aside.contains(e.target as Node) || (e.target as Element).closest('[data-action="navigation.open"], [data-action="TopBar.3"]')) return;
      if (searchOpen()) setSearchOpen(false);
      if (overlay() && open()) setMode(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (props.active?.() === false || o.captureOpen()) return;
      if (e.key !== 'Escape') return;
      if (searchOpen() || (overlay() && open())) {
        e.preventDefault(); e.stopPropagation();
        if ((e.target as HTMLElement).matches('input.search')) o.setQuery('', true);
        setSearchOpen(false);
        if (overlay()) collapse(); else toggle()?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    onCleanup(() => { observer.disconnect(); mutation.disconnect(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); });
    measure();
  });

  return (
    <aside id={props.navigationId ?? "document-navigation"} ref={aside} inert={!open()} class="navigation-sidebar" classList={{ expanded: open(), overlay: overlay(), 'search-visible': searchOpen(), 'touch-navigation': touchCapable() }} aria-label="Навигация по документу">
      <div class="navigation-surface">
        <SidebarCalendar o={o} open={open()} onNavigate={() => { if (overlay()) collapse(); }} />
        <div class="navigation-search" classList={{ visible: open() || searchOpen() }}>
          <SearchBar o={o} onRequest={() => setMode(true)} />
        </div>
        <Show when={open()}>
          <FavoriteList o={o} labelVersion={labels} navigate={(id) => {
            o.setFocus(null); o.zoomTo(id);
            if (overlay()) collapse();
          }} search={(query) => { o.setQuery(query, true); if (overlay()) collapse(); else o.requestSearch(); }} />
        </Show>
      </div>
    </aside>
  );
}
