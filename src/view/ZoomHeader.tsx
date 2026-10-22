import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import { prependChild } from '../model/commands';
import { caretOutside, plainText } from '../model/format';
import { decorate } from '../model/search';
import type { NodeId } from '../model/types';
import { caretOnFirstLine, caretOnLastLine, offsetFromPoint, selectionIn, setCaret } from './caret';
import { formatKeys, onGlobalKeys } from './keymap';
import type { Outliner, TitleEdit } from './outliner';
import { Pieces } from './Row';

/**
 * The path from the root to where you are, the place itself included:
 * "Главная" alone on the home page. A click on it goes home; on the home
 * page, it folds every top-level bullet. It stays above the list while the
 * zoomed-in bullet's title (ZoomTitle) scrolls away with it, as in Workflowy.
 * One line that never shortens a crumb: a long path scrolls sideways and
 * stays at its end, so the bullets next to where you are show whole.
 */
/** A mouse moved this far with its button down drags the path instead of pressing a crumb, px. */
const DRAG_SLOP = 4;

/**
 * A long path scrolls with a mouse too, not only a touchpad or a finger:
 * the wheel turns it sideways, and it drags with the button held. The wheel
 * at an end of the path is the page's again; a drag presses no crumb.
 */
function mouseScroll(nav: HTMLElement): void {
  nav.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // sideways already scrolls; Ctrl zooms
    const max = nav.scrollWidth - nav.clientWidth;
    if (max <= 0 || (e.deltaY < 0 && nav.scrollLeft <= 0) || (e.deltaY > 0 && nav.scrollLeft >= max - 1)) return;
    e.preventDefault();
    nav.scrollLeft += e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? nav.clientWidth : 1);
  }, { passive: false });

  let drag: { x: number; left: number; moved: boolean } | null = null;
  let dragged = false;
  nav.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || nav.scrollWidth <= nav.clientWidth) return;
    drag = { x: e.clientX, left: nav.scrollLeft, moved: false };
  });
  nav.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_SLOP) return;
      drag.moved = true;
      nav.setPointerCapture(e.pointerId);
      nav.classList.add('dragging');
    }
    nav.scrollLeft = drag.left - dx;
  });
  const end = () => {
    dragged = !!drag?.moved;
    drag = null;
    nav.classList.remove('dragging');
    // The click that ends a drag comes right after; a later one is a press again.
    if (dragged) setTimeout(() => (dragged = false));
  };
  nav.addEventListener('pointerup', end);
  nav.addEventListener('pointercancel', end);
  nav.addEventListener('click', (e) => {
    if (!dragged) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/** The narrowest the place's own crumb gets before the path scrolls instead, px (~8 characters). */
const CURRENT_MIN = 72;

export function Crumbs(props: { o: Outliner; scrolled: boolean }) {
  const o = props.o;
  let nav!: HTMLElement;
  /** From the root's first child down to the zoomed-in bullet. */
  const path = createMemo(() => {
    o.rowsVersion();
    const id = o.zoom();
    const out: NodeId[] = [];
    if (!id || !o.doc.has(id)) return out;
    for (let p: NodeId | null = id; p !== null && p !== o.doc.root; p = o.doc.get(p).parent) out.unshift(p);
    return out;
  });

  /**
   * Shows the end of the path; a faded left edge says there is more of it.
   * A path only a little too long does not scroll a few letters of "Главная"
   * under the fade: the place's own crumb gives way (its whole text is the
   * title below), down to CURRENT_MIN.
   */
  const toEnd = () => {
    const current = nav.querySelector<HTMLElement>('.crumb.current');
    if (current) {
      current.style.maxWidth = '';
      const over = nav.scrollWidth - nav.clientWidth;
      const width = current.getBoundingClientRect().width;
      if (over > 0 && width - over >= CURRENT_MIN) current.style.maxWidth = `${width - over}px`;
    }
    nav.scrollLeft = nav.scrollWidth;
    clip();
  };
  const clip = () => nav.classList.toggle('clipped', nav.scrollLeft > 1);
  // Kept at the end when the path changes, a crumb is renamed or the bar is resized.
  createEffect(on(() => path().map((id) => {
    o.nodes.track(id);
    return o.doc.nodes.get(id)?.text;
  }).join('\n'), toEnd));
  onMount(() => {
    const observer = new ResizeObserver(toEnd);
    observer.observe(nav);
    onCleanup(() => observer.disconnect());
    mouseScroll(nav);
  });

  return (
    <div class="crumbbar" classList={{ scrolled: props.scrolled }}>
      <nav ref={nav} class="crumbs" aria-label="Путь" onScroll={clip}>
        {/* Home; once there, every top-level bullet folded (`goHome`), an overview. */}
        <button
          type="button"
          class="crumb"
          classList={{ current: !path().length }}
          aria-current={path().length ? undefined : 'page'}
          title={path().length ? 'На главную' : 'Свернуть весь первый уровень; ещё раз — развернуть'}
          onClick={() => (path().length ? o.zoomTo(null, true) : o.goHome())}
        >
          Главная
        </button>
        <For each={path()}>
          {(p, i) => (
            <>
              <svg class="sep" width="8" height="10" viewBox="0 0 8 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 1.5 6 5l-3.5 3.5" />
              </svg>
              <Crumb o={o} id={p} current={i() === path().length - 1} />
            </>
          )}
        </For>
      </nav>
    </div>
  );
}

function Crumb(props: { o: Outliner; id: NodeId; current: boolean }) {
  const o = props.o;
  const id = props.id;
  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));
  const text = () => {
    o.nodes.track(id);
    return plainText(o.doc.nodes.get(id)?.text ?? '') || '…';
  };
  return (
    <Show
      when={!props.current}
      fallback={
        // The place's own crumb: its first level folded, an overview; again — open.
        <button type="button" class="crumb current" aria-current="page" title={`${text()} — свернуть всё внутри; ещё раз — развернуть`} onClick={() => o.toggleLevel()}>
          {text()}
        </button>
      }
    >
      <button type="button" class="crumb" title={text()} onClick={() => o.zoomTo(id, true)}>
        {text()}
      </button>
    </Show>
  );
}

/**
 * The zoomed-in bullet's text and, under it, its whole note. Both show like
 * a row's: tags filter on a click, links lead to their bullet, bold and
 * italic are styled. A click elsewhere makes that part editable where the
 * click was (TitleEditable, TitleNoteEditable); so does Ctrl+↑ from the
 * first row (`titleRequests`), and Shift+Enter goes between the two.
 */
export function ZoomTitle(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));
  const node = () => {
    o.nodes.track(id);
    return o.doc.nodes.get(id);
  };
  const text = () => node()?.text ?? '';
  const note = () => node()?.note ?? '';
  // Kept by the Outliner, so the editing bar on a touch screen sees it too.
  const edit = o.titleEdit;
  const setEdit = o.editTitle;
  setEdit(null);
  onCleanup(() => setEdit(null));
  /** An editor lost focus: editing ends, unless it has moved to the other part already. */
  const leave = (isNote: boolean) => edit()?.note === isNote && setEdit(null);
  const terms = () => o.filter()?.query.terms ?? [];
  const pieces = createMemo(() => decorate(text(), terms()));
  const notePieces = createMemo(() => decorate(note(), terms()));

  createEffect(on(o.titleRequests, () => !o.readOnly && setEdit({ note: false, caret: text().length }), { defer: true }));

  const onMouseDown = (isNote: boolean) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    // A web address opens on its click; the title is not edited.
    if ((e.target as HTMLElement).closest('a.url')) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const tag = target.dataset.tag;
    if (tag) return o.filterByTag(tag);
    const link = target.closest<HTMLElement>('[data-link]')?.dataset.link;
    if (link !== undefined) return o.followLink(link, id);
    if (o.readOnly) return;
    const value = isNote ? note() : text();
    const at = offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    setEdit({ note: isNote, caret: at === null ? value.length : caretOutside(value, at) });
  };

  return (
    <>
      <Show
        when={edit() && !edit()!.note}
        fallback={
          <div class="zoom-title" onMouseDown={onMouseDown(false)}>
            <Pieces o={o} pieces={pieces()} />
          </div>
        }
      >
        <TitleEditable o={o} id={id} text={text} caret={edit()!.caret} edit={setEdit} leave={() => leave(false)} />
      </Show>
      <Show
        when={edit()?.note}
        fallback={
          <Show when={note()}>
            <div class="note zoom-note" onMouseDown={onMouseDown(true)}>
              <Pieces o={o} pieces={notePieces()} />
            </div>
          </Show>
        }
      >
        <TitleNoteEditable o={o} id={id} note={note} caret={edit()!.caret} edit={setEdit} leave={() => leave(true)} textLength={() => text().length} />
      </Show>
    </>
  );
}

interface TitleEditorProps {
  o: Outliner;
  id: NodeId;
  caret: number;
  /** Moves editing to the other part, or ends it (null). */
  edit: (e: TitleEdit) => void;
  leave: () => void;
}

/**
 * The title being edited. Like a row's editor, the DOM is the source of
 * truth while typing; outside changes (undo) are written back. Enter starts
 * the first child, Shift+Enter goes to the note; leaving shows the title again.
 */
function TitleEditable(props: TitleEditorProps & { text: () => string }) {
  const o = props.o;
  const id = props.id;
  const text = props.text;
  let el!: HTMLDivElement;

  onMount(() => {
    el.textContent = text();
    el.focus({ preventScroll: true });
    setCaret(el, Math.min(props.caret, text().length));
  });

  createEffect(on(text, (t) => {
    if (el.textContent === t) return;
    const caret = selectionIn(el)?.[0];
    el.textContent = t;
    if (caret !== undefined) setCaret(el, Math.min(caret, t.length));
  }, { defer: true }));

  createEffect(on(o.titleRequests, () => {
    el.focus();
    setCaret(el, el.textContent?.length ?? 0);
  }, { defer: true }));

  const onInput = () => {
    const t = el.textContent ?? '';
    if (el.childNodes.length > 1 || el.firstElementChild || t.includes('\n')) {
      const caret = selectionIn(el)?.[0] ?? t.length;
      el.textContent = t.replace(/\n/g, ' ');
      setCaret(el, caret);
    }
    o.type(id, el.textContent ?? '');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || formatKeys(e, o, id, el, false)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return;
      if (e.shiftKey) return props.edit({ note: true, caret: o.doc.get(id).note.length });
      o.run((ctx) => prependChild(ctx, id));
    } else if (e.key === 'ArrowDown' && !e.altKey && !e.shiftKey && caretOnLastLine(el)) {
      // Down into the note first, if there is one; then the first row.
      if (o.doc.get(id).note) {
        e.preventDefault();
        return props.edit({ note: true, caret: 0 });
      }
      const first = o.rows.ids[0];
      if (first) {
        e.preventDefault();
        o.setFocus({ id: first, caret: 0 });
      }
    } else if (e.key === 'ArrowLeft' && e.altKey && !e.shiftKey) {
      e.preventDefault();
      o.zoomOut();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      el.blur();
    } else {
      onGlobalKeys(e, o);
    }
  };

  return (
    <div
      ref={el}
      class="zoom-title"
      contentEditable="plaintext-only"
      onFocus={() => o.setFocus(null)}
      onBlur={() => props.leave()}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onBeforeInput={(e) => historyInput(e, o)}
    />
  );
}

/**
 * The zoomed-in bullet's note being edited, as a row's (NoteEditable in
 * Row.tsx): Enter starts a new line; Shift+Enter, Esc or Backspace in an
 * empty note go back to the title.
 */
function TitleNoteEditable(props: TitleEditorProps & { note: () => string; textLength: () => number }) {
  const o = props.o;
  const id = props.id;
  const note = props.note;
  let el!: HTMLDivElement;
  // An empty last line only shows with a placeholder "\n" after it (Row.tsx).
  const read = () => (el.textContent ?? '').replace(/\n$/, '');
  const write = (t: string) => {
    el.textContent = t.endsWith('\n') ? `${t}\n` : t;
  };
  const toTitle = () => props.edit({ note: false, caret: props.textLength() });

  onMount(() => {
    write(note());
    el.focus({ preventScroll: true });
    setCaret(el, Math.min(props.caret, note().length));
  });

  createEffect(on(note, (t) => {
    if (read() === t) return;
    const caret = selectionIn(el)?.[0];
    write(t);
    if (caret !== undefined) setCaret(el, Math.min(caret, t.length));
  }, { defer: true }));

  const onInput = () => {
    // Other browsers may insert <br> for a new line: turn it back into text.
    if (el.querySelector('br')) {
      const caret = selectionIn(el)?.[0];
      write(el.innerText.replace(/\n$/, ''));
      if (caret !== undefined) setCaret(el, caret);
    }
    o.typeNote(id, read());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || formatKeys(e, o, id, el, true)) return;
    const mod = e.ctrlKey || e.metaKey;
    const [start, end] = selectionIn(el) ?? [0, 0];
    const handle = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === 'Enter' && mod) return handle(() => {});
    if ((e.key === 'Enter' && e.shiftKey) || e.key === 'Escape') return handle(toTitle);
    if (e.key === 'Backspace' && start === 0 && end === 0 && !read()) return handle(toTitle);
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !mod && caretOnFirstLine(el)) return handle(toTitle);
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !mod && caretOnLastLine(el)) {
      const first = o.rows.ids[0];
      if (first) return handle(() => o.setFocus({ id: first, caret: 0 }));
      return;
    }
    onGlobalKeys(e, o);
  };

  return (
    <div
      ref={el}
      class="note zoom-note"
      contentEditable="plaintext-only"
      onFocus={() => o.setFocus(null)}
      onBlur={() => props.leave()}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onBeforeInput={(e) => historyInput(e, o)}
    />
  );
}

/** Undo and redo from the browser's own menu, which bypass keydown. */
function historyInput(e: InputEvent, o: Outliner): void {
  if (e.inputType === 'historyUndo') {
    e.preventDefault();
    o.undo();
  } else if (e.inputType === 'historyRedo') {
    e.preventDefault();
    o.redo();
  }
}
