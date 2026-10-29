import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Symbol } from './Menu';
import type { Outliner } from './outliner';

/** Room kept between the menu and the window's edges, and between it and the finger, px. */
const MARGIN = 8;

/**
 * A row's menu of actions, where it was asked for: a finger held on the row
 * and lifted without moving it (drag.ts), as a long press works on an iPhone
 * or iPad, or a right click with a mouse or trackpad (Row.tsx). Actions a
 * phone's edit bar keeps two presses away are one here: open the bullet,
 * make it a task or a plain bullet again, write its note, move it, delete it (last, in red, as Apple sets a destructive action apart). A tap
 * anywhere else closes the menu and does nothing more.
 */
export function RowMenu(props: { o: Outliner }) {
  const o = props.o;
  return (
    <Show when={o.rowMenu()} keyed>
      {(at) => <Menu o={o} at={at} />}
    </Show>
  );
}

function Menu(props: { o: Outliner; at: { key: string; x: number; y: number } }) {
  const o = props.o;
  const key = props.at.key;
  let menu!: HTMLDivElement;
  /** A press began on the layer under the menu (not the long press that opened it). */
  let pressed = false;
  const [place, setPlace] = createSignal({ left: props.at.x, top: props.at.y + MARGIN });

  const n = () => o.contentOf(key);
  const close = () => o.closeRowMenu();
  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  onMount(() => {
    // Beside the finger, inside the window: above it when there is no room below.
    const { width, height } = menu.getBoundingClientRect();
    const { x, y } = props.at;
    const left = Math.max(MARGIN, Math.min(x - width / 2, innerWidth - width - MARGIN));
    const below = y + MARGIN;
    const top = below + height <= innerHeight - MARGIN ? below : Math.max(MARGIN, y - MARGIN - height);
    setPlace({ left, top });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
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
      {/* Takes the tap that closes the menu, so it does nothing to what is under it. It closes on the click, which
          would otherwise land on what is under the layer once the layer is gone; only a press begun on the layer:
          the click of the long press that opened the menu comes here too. */}
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
      <div ref={menu} class="menu row-menu" role="menu" style={{ left: `${place().left}px`, top: `${place().top}px` }} onMouseDown={(e) => e.preventDefault()}>
        <button type="button" role="menuitem" onClick={act(() => o.zoomTo(key))}>
          Открыть
          <Symbol><circle cx="12" cy="12" r="9" /><path d="M8 12h8M13 8.5l3.5 3.5-3.5 3.5" /></Symbol>
        </button>
        <Show when={!o.readOnly}>
          <Show
            when={n().todo}
            fallback={
              <button type="button" role="menuitem" onClick={act(() => o.toggleTask([key]))}>
                Сделать задачей
                <Symbol><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></Symbol>
              </button>
            }
          >
            <button type="button" role="menuitem" onClick={act(() => o.toggleDone([key]))}>
              {n().done ? 'Снять отметку' : 'Отметить выполненной'}
              <Symbol><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></Symbol>
            </button>
            <button type="button" role="menuitem" onClick={act(() => o.toggleTask([key]))}>
              Убрать чекбокс
              <Symbol><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></Symbol>
            </button>
          </Show>
          <button type="button" role="menuitem" onClick={act(() => o.setFocus({ id: key, caret: n().note.length, note: true }))}>
            Заметка
            <Symbol><path d="M5 7h14M5 12h14M5 17h8" /></Symbol>
          </button>
          <button type="button" role="menuitem" onClick={act(() => o.openMove([key]))}>
            Переместить в…
            <Symbol><path d="M3 7h6l2 2h10v10H3z" /><path d="M10 14h6M13 11l3 3-3 3" /></Symbol>
          </button>
          <div class="menu-sep" role="separator" />
          <button type="button" role="menuitem" class="destructive" onClick={act(() => o.swipeDelete(key))}>
            Удалить
            <Symbol><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Symbol>
          </button>
        </Show>
      </div>
    </>
  );
}
