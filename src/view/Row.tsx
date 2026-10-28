import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import * as cmd from '../model/commands';
import { dateWordBefore } from '../model/dates';
import { caretOutside, linkOver, plainText } from '../model/format';
import { closesLink, opensLink } from '../model/links';
import { closesMirror, mirrorBefore, opensMirror } from '../model/mirrors';
import { parseIndented } from '../model/outline-text';
import { nodeOf, type RowKey } from '../model/rows';
import { decorate, type Piece, type Query } from '../model/search';
import { TIME_COMMAND, timeCommandBefore, timeOfDay } from '../model/time';
import { lineHeight, offsetFromPoint, offsetNear, selectRange, selectionIn, setCaret } from './caret';
import { onEditorKeyDown, onNoteKeyDown } from './keymap';
import type { FocusRequest, Outliner } from './outliner';
import { suggestKey } from './Suggest';
import { phone } from './screen';
import { CALENDAR, swipe } from './swipe';

interface RowProps {
  o: Outliner;
  /** The row's key, fixed for the component's lifetime (model/rows.ts: under a mirror, not the bullet's id). */
  id: RowKey;
  depth: number;
  /** Starts measuring the row element; returns the stop function. */
  observe: (el: HTMLElement) => () => void;
  /** A press on the bullet: a click zooms in, a drag moves (drag.ts). */
  grab: (e: PointerEvent, id: RowKey, from?: 'bullet' | 'row') => void;
}

const inNote = (f: FocusRequest | null) => !!f && 'note' in f && !!f.note;

/**
 * Tags, search hits, bold and italic, links and web addresses within a text, as rendered spans.
 * Formatting markers stay in the DOM, hidden, so offsets in the element
 * are offsets in the text (a click puts the caret where it belongs).
 */
export function Pieces(props: { o: Outliner; pieces: Piece[]; query: Query | null }) {
  return (
    <For each={props.pieces}>
      {(p) => {
        if (p.marker) return <span class="md-marker">{p.text}</span>;
        const plain = p.hit ? <mark>{p.text}</mark> : p.text;
        const inner = p.link !== undefined
          ? <span class="link" data-link={p.link}>{plain}</span>
          : p.url !== undefined
            // Opens in the browser (another tab; the system browser from the installed app).
            ? <a class="url" href={p.url} target="_blank" rel="noopener noreferrer">{plain}</a>
            : p.tag
            ? <span class="tag" classList={{ active: !!props.query?.tags.some((t) => p.tag!.startsWith(t)), hit: !!p.hit }} data-tag={p.tag}>{p.text}</span>
            : plain;
        return p.bold || p.italic ? <span classList={{ 'md-bold': !!p.bold, 'md-italic': !!p.italic }}>{inner}</span> : inner;
      }}
    </For>
  );
}

/** The calendar that plans a bullet for a day (Planner.tsx, model/today.ts). */
function CalendarIcon(props: { size: number }) {
  return (
    <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {CALENDAR.map((d) => <path d={d} />)}
    </svg>
  );
}

/**
 * One bullet: its text and, under it, its note. Both render static, except
 * the part with the caret, which becomes an editable element (Editable,
 * NoteEditable).
 */
export function Row(props: RowProps) {
  const o = props.o;
  const id = props.id;
  const nid = nodeOf(id);
  let el!: HTMLDivElement;
  let bullet!: HTMLSpanElement;
  onMount(() => onCleanup(props.observe(el)));
  // A finger that picked the row up (drag.ts: by its bullet or its text)
  // moves it instead of scrolling the list. Must be a non-passive listener
  // of its own.
  onMount(() => {
    const hold = (e: TouchEvent) => {
      if (o.dragged().size && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', hold, { passive: false });
    onCleanup(() => el.removeEventListener('touchmove', hold));
  });
  /** A finger on the row's text, not the row being edited, nor what has a press of its own: held, it picks the row up (drag.ts). */
  const onRowPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || o.readOnly || focused()) return;
    if ((e.target as Element).closest('.bullet, .toggle, button, a, [contenteditable]')) return;
    props.grab(e, id, 'row');
  };
  /**
   * A held finger is a drag, not the browser's menu. A right click opens the
   * row's own menu (RowMenu.tsx) wherever it lands on the row, the text being
   * edited too: one menu, never the browser's beside it. Only a finger's long
   * press in the text being edited is left to the browser (it selects words).
   */
  const onContextMenu = (e: MouseEvent) => {
    if (el.classList.contains('holding') || o.dragged().size) return e.preventDefault();
    if (!document.documentElement.classList.contains('mouse') && (e.target as Element).closest('[contenteditable]')) return;
    e.preventDefault();
    o.openRowMenu(id, e.clientX, e.clientY);
  };
  // A finger sideways across the row: left deletes, right stars (swipe.ts).
  onMount(() => onCleanup(swipe(o, el, id, focused)));
  o.nodes.acquire(nid);
  onCleanup(() => o.nodes.release(nid));

  const node = () => {
    o.nodes.track(nid);
    return o.doc.nodes.get(nid);
  };
  /** What the row shows: the mirrored bullet for a mirror (model/mirrors.ts), else the bullet itself. */
  const content = () => {
    const n = node();
    if (!n?.mirrorOf) return n;
    o.nodes.track(n.mirrorOf);
    return o.doc.nodes.get(n.mirrorOf) ?? n;
  };
  // A mirror re-renders with its original: hold the original's signal while this row shows it.
  createEffect(on(() => node()?.mirrorOf ?? null, (target) => {
    if (!target) return;
    o.nodes.acquire(target);
    onCleanup(() => o.nodes.release(target));
  }));
  /** One of two or more copies of a bullet (model/mirrors.ts): a diamond, wherever it is. */
  const mirror = () => {
    o.rowsVersion();
    return !!node() && o.doc.isCopy(nid);
  };
  const orphan = () => !!node()?.mirrorOf && !o.doc.nodes.has(node()!.mirrorOf!);
  const focused = () => !o.readOnly && o.focus()?.id === id;
  const editingText = () => focused() && !inNote(o.focus());
  const editingNote = () => focused() && inNote(o.focus());
  // A mirror's children are its original's, shown under it (model/rows.ts).
  const folded = () => {
    o.rowsVersion();
    return !!content() && o.rows.hasHiddenChildren(id);
  };
  const hasChildren = () => {
    o.rowsVersion();
    return !!content() && (o.rows.host(id)?.children.length ?? 0) > 0;
  };
  const open = () => {
    o.rowsVersion();
    return !!content() && o.rows.unfolded(id);
  };
  /**
   * An open task inside the bullet while it is out of sight (folded, or
   * through a link): shown under the text, so what is to be done here reads
   * without opening it (Outliner.pendingFor). The task's own signal is held
   * while it shows, so its text follows edits made elsewhere.
   */
  const pending = createMemo(() => (content() ? o.pendingFor(id) : null), undefined, {
    equals: (a, b) => a?.task === b?.task && a?.more === b?.more,
  });
  createEffect(on(() => pending()?.task ?? null, (task) => {
    if (!task) return;
    o.nodes.acquire(task);
    onCleanup(() => o.nodes.release(task));
  }));
  const pendingText = () => {
    const p = pending();
    if (!p) return '';
    o.nodes.track(p.task);
    const t = o.doc.nodes.get(p.task);
    return t ? plainText(o.doc.content(t.id).text).trim() || 'Задача без текста' : '';
  };
  /** The bullet's plan: null if it cannot be planned, else the date it is planned for, if any (Outliner.planOf). */
  const plan = createMemo(() => o.planOf(id), undefined, { equals: (a, b) => a === b || (!!a && !!b && a.date?.y === b.date?.y && a.date?.m === b.date?.m && a.date?.d === b.date?.d) });
  const planned = () => plan()?.date ?? null;
  /** The calendar button or the date beside the text: the calendar opens beside the row. */
  const onPlan = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    o.openPlanner([id], (e.currentTarget as HTMLElement).getBoundingClientRect());
  };
  const query = () => o.highlightFor(nid);
  const terms = () => query()?.terms ?? [];
  const pieces = createMemo(() => decorate(content()?.text ?? '', terms()));
  const notePieces = createMemo(() => decorate(content()?.note ?? '', terms()));

  /** A click in static text: a tag filters, a link leads to its bullet, anything else puts the caret there. */
  const onStaticMouseDown = (note: boolean) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    // A web address opens on its click; the row is not edited.
    if ((e.target as HTMLElement).closest('a.url')) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const tag = target.dataset.tag;
    if (tag) return o.filterByTag(tag);
    const link = target.closest<HTMLElement>('[data-link]')?.dataset.link;
    if (link !== undefined) return o.followLink(link, id);
    // Shift+click selects the rows from the edited (or already selected) one to here.
    const anchor = o.selection()?.anchor ?? o.focus()?.id;
    if (e.shiftKey && anchor) {
      (document.activeElement as HTMLElement | null)?.blur();
      return o.select({ anchor, head: id });
    }
    if (o.readOnly) return;
    const text = (note ? content()?.note : content()?.text) ?? '';
    const at = offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    const caret = at === null ? text.length : caretOutside(text, at);
    o.setFocus(note ? { id, caret, note: true } : { id, caret });
    followDrag(note, caret);
  };

  /**
   * The press made the row editable, which swaps its element for another: the
   * browser's own drag selection, anchored in the old one, never starts. So
   * until the button is released the selection follows the pointer by hand,
   * from where the press put the caret.
   */
  const followDrag = (note: boolean, anchor: number) => {
    const move = (e: MouseEvent) => {
      if (!(e.buttons & 1)) return stop();
      const target = el.querySelector<HTMLElement>(note ? '.note[contenteditable]' : '.text[contenteditable]');
      if (target) selectRange(target, anchor, offsetNear(target, e.clientX, e.clientY));
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };


  const onToggleMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (node()) o.fold(id);
  };

  return (
    <div
      ref={el}
      class="row"
      classList={{ done: !!content()?.done, mirror: mirror(), orphan: orphan(), selected: o.selectedSet().has(id), dragged: o.dragged().has(id), 'menu-target': o.rowMenu()?.key === id }}
      data-id={id}
      data-depth={props.depth}
      onPointerDown={onRowPointerDown}
      // The browser's long press (a word selected, a menu) would come while the finger holds the row.
      onContextMenu={onContextMenu}
      style={{ 'padding-left': 'var(--shift)', '--depth': String(props.depth) }}
    >
      <Show when={hasChildren()}>
        <span class="toggle" classList={{ open: open() }} onMouseDown={onToggleMouseDown} aria-hidden="true">
          {/* A chevron, Apple's disclosure mark: › closed, turning to ⌄ when open. */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
        </span>
      </Show>
      <span
        ref={bullet}
        class="bullet"
        classList={{ collapsed: folded(), todo: !!content()?.todo, checked: !!content()?.done, mirror: mirror() }}
        role={content()?.todo ? 'checkbox' : undefined}
        aria-checked={content()?.todo ? !!content()?.done : undefined}
        title={mirror() ? 'Зеркало: этот пункт есть и в других местах, правка меняет все копии' : undefined}
        // No default on mousedown: DOM focus stays in the row being edited.
        onMouseDown={(e) => e.preventDefault()}
        // A held finger is a drag, not the browser's context menu.
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => !o.readOnly ? props.grab(e, id) : e.button === 0 && !content()?.todo && o.zoomTo(id)}
      />
      <div class="body">
        {/* The day it is planned for (model/today.ts): «сегодня», «завтра», else the date, at the end of the first line (floated, so
            the text goes round it, edited or not); a press opens the calendar. */}
        <Show when={planned()}>
          {(date) => (
            <button
              type="button"
              class="plan-date"
              classList={{ today: o.planLabel(date()) === 'сегодня' }}
              aria-label={`Запланировано на ${o.planLabel(date())}: изменить`}
              title="Запланировано (Ctrl+S): изменить или отменить"
              disabled={o.readOnly}
              onMouseDown={onPlan}
            >
              <CalendarIcon size={13} />
              {o.planLabel(date())}
            </button>
          )}
        </Show>
        <Show
          when={editingText()}
          fallback={
            <div class="text" onMouseDown={onStaticMouseDown(false)}>
              <Pieces o={o} pieces={pieces()} query={query()} />
              {/* The bullet has a sketch: it shows beside its list once zoomed in (Sketch.tsx). */}
              <Show when={content()?.strokes}>
                <svg class="sketch-mark" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-label="Скетч">
                  <path d="M3 17c3-6 5-9 7-9s0 8 3 8 4-7 8-9" />
                  <path d="M3 21h18" />
                </svg>
              </Show>
            </div>
          }
        >
          <Editable o={o} id={id} />
        </Show>
        <Show when={pending()}>
          {(p) => (
            <div class="pending" title={`Незавершённая задача внутри${p().more ? ` (и ещё ${p().more})` : ''}`}>
              <button
                type="button"
                class="pending-box"
                aria-label={`Отметить выполненной: ${pendingText()}`}
                disabled={o.readOnly}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => o.completeTask(p().task)}
              />
              <span class="pending-text" onMouseDown={(e) => { if (e.button !== 0) return; e.preventDefault(); o.goToTask(p().task); }}>
                {pendingText()}
              </span>
              <Show when={p().more}>
                <span class="pending-more">+{p().more}</span>
              </Show>
            </div>
          )}
        </Show>
        <Show
          when={editingNote()}
          fallback={
            <Show when={content()?.note}>
              {/* Its first lines only (NOTE_LINES), all of them while the row is edited. */}
              <div class="note" classList={{ clamped: !focused() }} onMouseDown={onStaticMouseDown(true)}>
                <Pieces o={o} pieces={notePieces()} query={query()} />
              </div>
            </Show>
          }
        >
          <NoteEditable o={o} id={id} />
        </Show>
      </div>
      {/* The calendar button (model/today.ts): with a mouse, at the row's end, shown while the pointer is over the row (always on a tablet); once planned, the date in the line takes its place. */}
      <Show when={!phone() && plan() !== null && planned() === null && !o.readOnly}>
        <button
          type="button"
          class="plan-button"
          aria-label="Запланировать"
          title="Запланировать на день (Ctrl+S)"
          onMouseDown={onPlan}
        >
          <CalendarIcon size={16} />
        </button>
      </Show>
    </div>
  );
}

/**
 * `/time` typed before the caret becomes the current time, and a day's
 * word with a space after it (`@today `, model/dates.ts) the day's tags.
 * While a word is being composed (Android keyboards compose every word)
 * the text must not be touched, so there the check waits for the
 * composition to end.
 */
const timeCommand = (o: Outliner, id: RowKey, el: HTMLElement, text: string, note: boolean) => {
  const caret = selectionIn(el)?.[0];
  if (caret === undefined) return;
  const at = note ? { id, caret, note: true as const } : { id, caret };
  if (timeCommandBefore(text, caret)) return o.insert(at, timeOfDay(), TIME_COMMAND.length);
  const day = dateWordBefore(text, caret);
  // The space typed stays after the tags.
  if (day) o.insert(at, day.text + text[caret - 1], caret - day.start);
};

/**
 * `[[` typed: closed with `]]` at once, the caret between, ready for the
 * title (and the suggestions, Suggest.tsx). In a bullet's text `((` closes
 * with `))` the same way (a mirror, model/mirrors.ts). Returns the text to keep.
 */
const closeLink = (e: InputEvent, el: HTMLElement, text: string, write: (t: string) => void, mirrors = false): string => {
  if (e.isComposing || e.inputType !== 'insertText') return text;
  const caret = selectionIn(el)?.[0];
  if (caret === undefined) return text;
  let closer: string;
  if (e.data === '[' && opensLink(text, caret)) closer = ']]';
  else if (mirrors && e.data === '(' && opensMirror(text, caret)) closer = '))';
  else return text;
  const next = `${text.slice(0, caret)}${closer}${text.slice(caret)}`;
  write(next);
  setCaret(el, caret);
  return next;
};

/**
 * Before the browser edits the text: undo/redo from its menu (which bypasses
 * keydown), `]` stepping over a link's closing bracket, Backspace taking out
 * an empty `[]` pair whole. `read`/`write` give the element's text. With
 * `mirror` (a bullet's text, not a note) the last `)` typed of `((title))`
 * makes the mirror (`Outliner.mirrorTitled`).
 */
function beforeInput(
  e: InputEvent, o: Outliner, id: RowKey, el: HTMLElement, read: () => string, write: (t: string) => void, save: (t: string) => void, mirror = false,
): void {
  if (e.inputType === 'historyUndo') {
    e.preventDefault();
    return o.undo();
  }
  if (e.inputType === 'historyRedo') {
    e.preventDefault();
    return o.redo();
  }
  if (e.isComposing || !e.cancelable) return;
  const sel = selectionIn(el);
  if (!sel || sel[0] !== sel[1]) return;
  const caret = sel[0];
  const text = read();
  if (e.inputType === 'insertText' && ((e.data === ']' && closesLink(text, caret)) || (e.data === ')' && closesMirror(text, caret)))) {
    e.preventDefault();
    // The last `)` of a mirror typed out: the mirror itself, of a new bullet in the Inbox if need be.
    const token = mirror && e.data === ')' && !text.startsWith('))', caret) ? mirrorBefore(text, caret - 1) : null;
    if (token && o.mirrorTitled(id, token.query, token.start, token.end)) return;
    setCaret(el, caret + 1);
  } else if (e.inputType === 'deleteContentBackward' && ((text[caret - 1] === '[' && text[caret] === ']') || (text[caret - 1] === '(' && text[caret] === ')'))) {
    e.preventDefault();
    const next = text.slice(0, caret - 1) + text.slice(caret + 1);
    write(next);
    setCaret(el, caret - 1);
    save(next);
  }
}


/**
 * A web address pasted over selected words in a note or a zoom title: they
 * become its link, `[words](address)`, typed as if by hand (the editor's own
 * input path keeps it). Anything else pastes as the browser does.
 */
export function pasteLink(e: ClipboardEvent, el: HTMLElement): void {
  const pasted = e.clipboardData?.getData('text/plain');
  const sel = selectionIn(el);
  if (pasted == null || !sel || sel[0] === sel[1]) return;
  const link = linkOver(el.textContent ?? '', sel[0], sel[1], pasted);
  if (!link) return;
  e.preventDefault();
  document.execCommand('insertText', false, link);
}

/** Places the caret for a focus request: at an offset, or at a horizontal position on the first/last line. */
function placeCaret(el: HTMLElement, f: FocusRequest): void {
  el.focus({ preventScroll: true });
  const len = el.textContent?.length ?? 0;
  if ('caret' in f) return setCaret(el, Math.min(f.caret, len));
  const r = el.getBoundingClientRect();
  const half = lineHeight(el) / 2;
  const y = f.line === 'first' ? r.top + half : r.bottom - half;
  setCaret(el, offsetFromPoint(el, f.x, y) ?? (f.line === 'first' ? 0 : len));
}

/**
 * The focused row's contenteditable. While typing, the DOM is the source of
 * truth: input is copied into the model and never rendered back, so the
 * caret stays put. Only changes made elsewhere (merge, paste, undo) are
 * written into the DOM. Invariant: the element holds a single text node.
 */
function Editable(props: { o: Outliner; id: RowKey }) {
  const o = props.o;
  const id = props.id;
  const nid = nodeOf(id);
  let el!: HTMLDivElement;
  // Through a mirror, the original's text (model/mirrors.ts): tracked by both ids.
  const text = () => {
    o.nodes.track(nid);
    const n = o.doc.nodes.get(nid);
    if (n?.mirrorOf) o.nodes.track(n.mirrorOf);
    return n ? o.doc.content(nid).text : '';
  };

  onMount(() => {
    el.textContent = text();
  });

  createEffect(on(text, (t) => {
    if (el.textContent === t) return;
    const caret = selectionIn(el)?.[0];
    el.textContent = t;
    if (caret !== undefined) setCaret(el, Math.min(caret, t.length));
  }, { defer: true }));

  createEffect(() => {
    const f = o.focus();
    if (f?.id === id && !inNote(f)) placeCaret(el, f);
  });

  const onInput = (e: InputEvent) => {
    const t = el.textContent ?? '';
    if (el.childNodes.length > 1 || el.firstElementChild || t.includes('\n')) {
      const caret = selectionIn(el)?.[0] ?? t.length;
      el.textContent = t.replace(/\n/g, ' ');
      setCaret(el, caret);
    }
    const write = (t: string) => (el.textContent = t);
    o.type(id, closeLink(e, el, el.textContent ?? '', write, true));
    if (!e.isComposing) timeCommand(o, id, el, el.textContent ?? '', false);
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = e.clipboardData?.getData('text/plain');
    if (pasted == null) return;
    e.preventDefault();
    const [start, end] = selectionIn(el) ?? [0, 0];
    // A web address over selected words: they become its link, [words](address).
    const link = start < end ? linkOver(el.textContent ?? '', start, end, pasted) : null;
    if (link) o.run((ctx) => cmd.insertText(ctx, id, start, end, [link]));
    // Several lines: an indented list (Markdown, Workflowy, plain) becomes a tree.
    else if (/[\r\n]/.test(pasted)) o.run((ctx) => cmd.insertTrees(ctx, id, start, end, parseIndented(pasted)));
    else o.run((ctx) => cmd.insertText(ctx, id, start, end, [pasted]));
  };

  return (
    <div
      ref={el}
      class="text"
      contentEditable="plaintext-only"
      onKeyDown={(e) => suggestKey(e) || onEditorKeyDown(e, o, id, el)}
      onInput={onInput}
      onCompositionEnd={() => timeCommand(o, id, el, el.textContent ?? '', false)}
      onPaste={onPaste}
      onBeforeInput={(e) => beforeInput(e, o, id, el, () => el.textContent ?? '', (t) => (el.textContent = t), (t) => o.type(id, t), true)}
    />
  );
}

/**
 * The note under the focused row, editable. Unlike the text it spans lines:
 * Enter starts a new line; Shift+Enter or Esc go back to the text.
 */
function NoteEditable(props: { o: Outliner; id: RowKey }) {
  const o = props.o;
  const id = props.id;
  const nid = nodeOf(id);
  let el!: HTMLDivElement;
  const note = () => {
    o.nodes.track(nid);
    const n = o.doc.nodes.get(nid);
    if (n?.mirrorOf) o.nodes.track(n.mirrorOf);
    return n ? o.doc.content(nid).note : '';
  };
  // An empty last line only shows with a placeholder "\n" after it (Chromium
  // adds one itself on Enter): the DOM holds the note plus that placeholder.
  const read = () => (el.textContent ?? '').replace(/\n$/, '');
  const write = (t: string) => {
    el.textContent = t.endsWith('\n') ? `${t}\n` : t;
  };

  onMount(() => write(note()));

  createEffect(on(note, (t) => {
    if (read() === t) return;
    const caret = selectionIn(el)?.[0];
    write(t);
    if (caret !== undefined) setCaret(el, Math.min(caret, t.length));
  }, { defer: true }));

  createEffect(() => {
    const f = o.focus();
    if (f?.id === id && inNote(f)) placeCaret(el, f);
  });

  const onInput = (e: InputEvent) => {
    // Other browsers may insert <br> for a new line: turn it back into text.
    if (el.querySelector('br')) {
      const caret = selectionIn(el)?.[0];
      write(el.innerText.replace(/\n$/, ''));
      if (caret !== undefined) setCaret(el, caret);
    }
    o.typeNote(id, closeLink(e, el, read(), write));
    if (!e.isComposing) timeCommand(o, id, el, read(), true);
  };

  return (
    <div
      ref={el}
      class="note"
      contentEditable="plaintext-only"
      onKeyDown={(e) => suggestKey(e) || onNoteKeyDown(e, o, id, el)}
      onInput={onInput}
      onPaste={(e) => pasteLink(e, el)}
      onCompositionEnd={() => timeCommand(o, id, el, read(), true)}
      onBeforeInput={(e) => beforeInput(e, o, id, el, read, write, (t) => o.typeNote(id, t))}
    />
  );
}
