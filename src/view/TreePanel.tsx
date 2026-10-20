import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import { selectionIn } from './caret';
import { List } from './Outline';
import type { FocusRequest, Outliner } from './outliner';
import { narrow } from './screen';
import type { TreeOutliner } from './tree';

const WIDTH = 'listik-tree-width';
const MIN = 200;
const MAX = 560;
const DEFAULT = 280;

function readWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH));
    return w >= MIN && w <= MAX ? w : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function writeWidth(w: number): void {
  try {
    if (w === DEFAULT) localStorage.removeItem(WIDTH);
    else localStorage.setItem(WIDTH, String(w));
  } catch {
    // Storage unavailable: the width lasts for this page.
  }
}

/**
 * The tree panel: the whole document as a tree beside the outline, to move
 * about it quickly and to jot something down without leaving the place in
 * the outline (tree.ts). A bullet's dot opens it in the outline; the
 * outline's place is marked, and the way to it unfolds as it changes.
 *
 * On a computer it stands to the left of the outline, its width dragged by
 * its edge (double click: back to the default; ← → on the focused edge);
 * the width and whether it is open are remembered. On a phone it is a
 * drawer over the outline, closed by a tap beside it, a swipe to the left,
 * or opening a bullet.
 */
export function TreePanel(props: { o: Outliner; tree: TreeOutliner }) {
  const o = props.o;
  const tree = props.tree;
  const [width, setWidth] = createSignal(readWidth());

  tree.onOpen = () => {
    if (narrow()) o.showTree(false);
  };

  // Opened, and as the outline moves: its place unfolds and comes into view here.
  createEffect(on([o.treeOpen, o.zoom], ([open, zoom]) => {
    if (open) tree.follow(zoom);
  }));

  // On a phone the drawer covers the outline: its keyboard and editing bar step aside.
  createEffect(on(o.treeOpen, (open) => {
    if (open && narrow()) o.setFocus(null);
  }, { defer: true }));

  /**
   * Where the caret was in the outline when the panel was pressed: the
   * outline's focus request is where editing began, typing has moved on
   * since, so the offset is read off the page before the panel takes focus.
   */
  let back: FocusRequest | null = null;
  const onPointerDown = () => {
    const el = document.activeElement as HTMLElement | null;
    const f = o.focus();
    const offset = el?.isContentEditable && el.closest('.main') ? selectionIn(el)?.[0] : undefined;
    if (f && offset !== undefined) back = el!.classList.contains('note') ? { id: f.id, caret: offset, note: true } : { id: f.id, caret: offset };
  };

  /** Esc in the panel: back to where the caret was in the outline. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    queueMicrotask(() => {
      if (tree.focus()) return;
      const to = back ?? o.focus();
      back = null;
      if (to) o.setFocus({ ...to });
    });
  };

  const startResize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = width();
    document.body.classList.add('resizing');
    const move = (m: PointerEvent) => setWidth(Math.round(Math.min(MAX, Math.max(MIN, w0 + m.clientX - x0))));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      writeWidth(width());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const onResizeKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setWidth((w) => Math.min(MAX, Math.max(MIN, w + (e.key === 'ArrowLeft' ? -16 : 16))));
    writeWidth(width());
  };

  /** A swipe to the left closes the drawer. */
  let swipe: { x: number; y: number } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    swipe = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (swipe && t && swipe.x - t.clientX > 70 && Math.abs(t.clientY - swipe.y) < 50) o.showTree(false);
    swipe = null;
  };
  onCleanup(() => {
    tree.onOpen = null;
  });

  return (
    <Show when={o.treeOpen()}>
      <Show when={narrow()}>
        <div class="tree-scrim" onClick={() => o.showTree(false)} />
      </Show>
      <aside
        class="tree"
        aria-label="Дерево"
        style={narrow() ? undefined : { width: `${width()}px` }}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div class="tree-head">
          <h2>Дерево</h2>
          <button
            type="button"
            class="tree-close"
            title={narrow() ? 'Закрыть' : 'Скрыть дерево (Ctrl+\\)'}
            aria-label="Скрыть дерево"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => o.showTree(false)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </div>
        <List o={tree} />
        <Show when={!narrow()}>
          <div
            class="tree-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Ширина дерева"
            aria-valuemin={MIN}
            aria-valuemax={MAX}
            aria-valuenow={width()}
            tabIndex={0}
            title="Потяните, чтобы изменить ширину; двойной клик — обычная ширина"
            onPointerDown={startResize}
            onDblClick={() => {
              setWidth(DEFAULT);
              writeWidth(DEFAULT);
            }}
            onKeyDown={onResizeKey}
          />
        </Show>
      </aside>
    </Show>
  );
}
