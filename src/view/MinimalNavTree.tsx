import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type Accessor } from 'solid-js';
import { calendarName } from '../model/calendar';
import { plainText } from '../model/format';
import type { RowKey } from '../model/rows';
import { navigationRows, navigationSelection, revealNavigation, type NavigationRow } from './navigation-tree';
import type { Outliner } from './outliner';

export interface MinimalNavController {
  o: Outliner;
  rows: Accessor<NavigationRow[]>;
  expanded: Accessor<Set<RowKey>>;
  selectedKey: Accessor<RowKey | null>;
  locatedKey: Accessor<RowKey | null>;
  canLocate: Accessor<boolean>;
  hasExpanded: Accessor<boolean>;
  go: (id: string | null, key?: RowKey, after?: () => void) => void;
  toggleBranch: (key: RowKey, e: MouseEvent) => void;
  collapseAll: () => void;
  locateCurrent: () => void;
  labelOf: (id: string) => string;
  countOf: (id: string) => number;
  setListEl: (el: HTMLDivElement) => void;
}

export function createMinimalNav(o: Outliner): MinimalNavController {
  let listEl: HTMLDivElement | undefined;

  const [docVersion, setDocVersion] = createSignal(0);
  const [expanded, setExpanded] = createSignal<Set<RowKey>>(new Set());
  const [preferredKey, setPreferredKey] = createSignal<RowKey | undefined>(undefined);
  const [locatedKey, setLocatedKey] = createSignal<RowKey | null>(null);
  let locateTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(o.doc.subscribe({
    commit: () => setDocVersion((v) => v + 1),
    rollback: () => setDocVersion((v) => v + 1),
  }));
  onCleanup(() => clearTimeout(locateTimer));

  // Reveal the active branch path when zooming from the editor or crumbs, keeping neighbouring open branches intact.
  createEffect(on(() => o.zoom(), (id) => {
    if (!id) {
      setPreferredKey(undefined);
      return;
    }
    setExpanded((prev) => revealNavigation(o.doc, id, prev));
  }));

  const rows = createMemo<NavigationRow[]>(() => {
    docVersion();
    o.rowsVersion();
    return navigationRows(o.doc, expanded(), { branchesOnly: true });
  });

  const selectedKey = createMemo<RowKey | null>(() => {
    docVersion();
    return navigationSelection(rows(), o.doc, o.zoom(), preferredKey());
  });

  const canLocate = createMemo(() => {
    docVersion();
    const z = o.zoom();
    if (!z || !o.doc.has(z) || !o.doc.inOutline(z)) return false;
    const host = o.doc.host(z);
    return !!host?.children.length || o.doc.get(z).parent !== o.doc.root;
  });

  const hasExpanded = () => expanded().size > 0;

  const go = (id: string | null, key?: RowKey, after?: () => void) => {
    setPreferredKey(key);
    o.editTitle(null);
    o.setFocus(null);
    o.select(null);
    o.zoomTo(id, true);
    after?.();
  };

  const toggleBranch = (key: RowKey, e: MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const collapseAll = () => {
    if (!expanded().size) return;
    setExpanded(new Set<RowKey>());
  };

  const locateCurrent = () => {
    const z = o.zoom();
    if (!z || !canLocate()) return;
    const next = revealNavigation(o.doc, z, new Set());
    setExpanded(next);
    const target = navigationSelection(
      navigationRows(o.doc, next, { branchesOnly: true }),
      o.doc,
      z,
      preferredKey(),
    );
    if (!target) return;
    clearTimeout(locateTimer);
    setLocatedKey(target);
    queueMicrotask(() => {
      const el = listEl?.querySelector<HTMLElement>(`[data-nav-key="${CSS.escape(target)}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    locateTimer = setTimeout(() => setLocatedKey((cur) => (cur === target ? null : cur)), 600);
  };

  const labelOf = (id: string) => {
    docVersion();
    if (!o.doc.has(id)) return '…';
    return calendarName(o.doc, id, 'crumb') ?? (plainText(o.doc.get(id).text) || '…');
  };

  const countOf = (id: string) => {
    docVersion();
    return o.doc.host(id)?.children.length ?? 0;
  };

  return {
    o,
    rows,
    expanded,
    selectedKey,
    locatedKey,
    canLocate,
    hasExpanded,
    go,
    toggleBranch,
    collapseAll,
    locateCurrent,
    labelOf,
    countOf,
    setListEl: (el) => { listEl = el; },
  };
}

export function MinimalNavHeader(props: { nav: MinimalNavController; onClose: () => void }) {
  return (
    <div class="minimal-nav-header">
      <span class="minimal-nav-title">Дерево</span>
      <div class="minimal-nav-actions">
        <button
          type="button"
          class="minimal-nav-btn"
          data-action="minimal.nav.locate"
          title="Показать текущую ветку"
          aria-label="Показать текущую ветку"
          disabled={!props.nav.canLocate()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.nav.locateCurrent()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
            <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21" />
          </svg>
        </button>
        <button
          type="button"
          class="minimal-nav-btn"
          data-action="minimal.nav.collapseAll"
          title="Свернуть всё в дереве"
          aria-label="Свернуть всё в дереве"
          disabled={!props.nav.hasExpanded()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.nav.collapseAll()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 5l5 5 5-5" />
            <path d="M7 19l5-5 5 5" />
          </svg>
        </button>
        <span class="minimal-nav-sep" aria-hidden="true" />
        <button
          type="button"
          class="minimal-nav-btn"
          data-action="minimal.nav.close"
          title="Скрыть дерево"
          aria-label="Скрыть дерево"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onClose()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function MinimalNavTree(props: {
  nav: MinimalNavController;
  open: Accessor<boolean>;
  overlay: Accessor<boolean>;
  onClose: () => void;
  navId: string;
}) {
  const nav = props.nav;

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !props.open() || !props.overlay()) return;
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  const navigate = (id: string | null, key?: RowKey) => {
    nav.go(id, key, () => {
      if (props.overlay()) props.onClose();
    });
  };

  return (
    <>
      <Show when={props.overlay() && props.open()}>
        <div class="minimal-nav-backdrop" aria-hidden="true" onClick={() => props.onClose()} />
      </Show>
      <aside
        id={props.navId}
        class="minimal-nav"
        classList={{ open: props.open(), overlay: props.overlay() }}
        inert={!props.open()}
        aria-label="Дерево навигации"
      >
        <Show when={props.overlay()}>
          <MinimalNavHeader nav={nav} onClose={props.onClose} />
        </Show>
        <div ref={(el) => nav.setListEl(el)} class="minimal-nav-list" role="tree" aria-label="Ветки документа">
          <div
            role="treeitem"
            aria-level={1}
            aria-current={nav.o.zoom() === null ? 'page' : undefined}
            class="minimal-nav-row minimal-nav-home"
            classList={{ active: nav.o.zoom() === null }}
            onClick={() => navigate(null)}
          >
            <span class="minimal-nav-home-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
                <path d="M9 21v-8h6v8" />
              </svg>
            </span>
            <span class="minimal-nav-label">Главная</span>
          </div>
          <For each={nav.rows()}>
            {(row) => {
              const isOpen = () => nav.expanded().has(row.key);
              const isActive = () => nav.selectedKey() === row.key;
              const guides = () => Array.from({ length: row.depth }, (_, i) => i);
              return (
                <div
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-expanded={row.children ? isOpen() : undefined}
                  aria-current={isActive() ? 'page' : undefined}
                  data-nav-key={row.key}
                  data-nav-id={row.id}
                  class="minimal-nav-row"
                  classList={{ active: isActive(), located: nav.locatedKey() === row.key }}
                  style={{ 'padding-left': `${6 + row.depth * 16}px` }}
                  onClick={() => navigate(row.id, row.key)}
                >
                  <For each={guides()}>
                    {(g) => (
                      <span
                        class="minimal-nav-guide"
                        aria-hidden="true"
                        style={{ left: `${15 + g * 16}px` }}
                      />
                    )}
                  </For>
                  <Show
                    when={row.children}
                    fallback={<span class="minimal-nav-spacer" aria-hidden="true" />}
                  >
                    <button
                      type="button"
                      class="minimal-nav-chev"
                      classList={{ open: isOpen() }}
                      aria-label={isOpen() ? 'Свернуть ветку' : 'Развернуть ветку'}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => nav.toggleBranch(row.key, e)}
                    >
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M4.2 2.5 7.8 6l-3.6 3.5" />
                      </svg>
                    </button>
                  </Show>
                  <span class="minimal-nav-dot-slot" aria-hidden="true">
                    <span class="minimal-nav-dot" />
                  </span>
                  <span class="minimal-nav-label" title={nav.labelOf(row.id)}>{nav.labelOf(row.id)}</span>
                  <span class="minimal-nav-count" aria-hidden="true">{nav.countOf(row.id)}</span>
                </div>
              );
            }}
          </For>
        </div>
      </aside>
    </>
  );
}
