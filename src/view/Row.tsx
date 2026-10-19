import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import * as cmd from '../model/commands';
import { parseIndented } from '../model/outline-text';
import { decorate, type Piece } from '../model/search';
import { TIME_COMMAND, timeCommandBefore, timeOfDay } from '../model/time';
import type { NodeId } from '../model/types';
import { lineHeight, offsetFromPoint, offsetNear, selectRange, selectionIn, setCaret } from './caret';
import { onEditorKeyDown, onNoteKeyDown } from './keymap';
import type { FocusRequest, Outliner } from './outliner';
import { suggestKey } from './Suggest';

interface RowProps {
  o: Outliner;
  /** Fixed for the component's lifetime: rows are keyed by id. */
  id: NodeId;
  depth: number;
  /** Starts measuring the row element; returns the stop function. */
  observe: (el: HTMLElement) => () => void;
  /** A press on the bullet: a click zooms in, a drag moves (drag.ts). */
  grab: (e: PointerEvent, id: NodeId) => void;
}

const inNote = (f: FocusRequest | null) => !!f && 'note' in f && !!f.note;

/**
 * Tags, search hits, bold and italic within a text, as rendered spans.
 * Formatting markers stay in the DOM, hidden, so offsets in the element
 * are offsets in the text (a click puts the caret where it belongs).
 */
function Pieces(props: { o: Outliner; pieces: Piece[] }) {
  return (
    <For each={props.pieces}>
      {(p) => {
        if (p.marker) return <span class="md-marker">{p.text}</span>;
        const inner = p.tag
          ? <span class="tag" classList={{ active: !!props.o.filter()?.query.tags.includes(p.tag), hit: !!p.hit }} data-tag={p.tag}>{p.text}</span>
          : p.hit ? <mark>{p.text}</mark> : p.text;
        return p.bold || p.italic ? <span classList={{ 'md-bold': !!p.bold, 'md-italic': !!p.italic }}>{inner}</span> : inner;
      }}
    </For>
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
  let el!: HTMLDivElement;
  let bullet!: HTMLSpanElement;
  onMount(() => onCleanup(props.observe(el)));
  // A finger that picked the bullet up (drag.ts) moves it instead of
  // scrolling the list. Must be a non-passive listener of its own.
  onMount(() => {
    const hold = (e: TouchEvent) => {
      if (o.dragged().size && e.cancelable) e.preventDefault();
    };
    bullet.addEventListener('touchmove', hold, { passive: false });
    onCleanup(() => bullet.removeEventListener('touchmove', hold));
  });
  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));

  const node = () => {
    o.nodes.track(id);
    return o.doc.nodes.get(id);
  };
  const focused = () => !o.readOnly && o.focus()?.id === id;
  const editingText = () => focused() && !inNote(o.focus());
  const editingNote = () => focused() && inNote(o.focus());
  const folded = () => {
    o.rowsVersion();
    const n = node();
    return !!n && o.rows.hasHiddenChildren(n);
  };
  const hasChildren = () => (node()?.children.length ?? 0) > 0;
  const open = () => {
    o.rowsVersion();
    const n = node();
    return !!n && o.rows.showsChildren(n);
  };
  const terms = () => o.filter()?.query.terms ?? [];
  const pieces = createMemo(() => decorate(node()?.text ?? '', terms()));
  const notePieces = createMemo(() => decorate(node()?.note ?? '', terms()));

  /** A click in static text: a tag filters, anything else puts the caret there. */
  const onStaticMouseDown = (note: boolean) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const tag = (e.target as HTMLElement).dataset.tag;
    if (tag) return o.filterByTag(tag);
    // Shift+click selects the rows from the edited (or already selected) one to here.
    const anchor = o.selection()?.anchor ?? o.focus()?.id;
    if (e.shiftKey && anchor) {
      (document.activeElement as HTMLElement | null)?.blur();
      return o.select({ anchor, head: id });
    }
    if (o.readOnly) return;
    const caret = offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    const length = (note ? node()?.note : node()?.text)?.length ?? 0;
    o.setFocus(note ? { id, caret: caret ?? length, note: true } : { id, caret: caret ?? length });
    followDrag(note, caret ?? length);
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
      classList={{ done: !!node()?.done, selected: o.selectedSet().has(id), dragged: o.dragged().has(id) }}
      data-id={id}
      data-depth={props.depth}
      style={{ 'padding-left': `calc(var(--indent) * ${props.depth})`, '--depth': String(props.depth) }}
    >
      <Show when={hasChildren()}>
        <span class="toggle" classList={{ open: open() }} onMouseDown={onToggleMouseDown} aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5 7.5 5 3 8.5z" /></svg>
        </span>
      </Show>
      <span
        ref={bullet}
        class="bullet"
        classList={{ collapsed: folded(), todo: !!node()?.todo, checked: !!node()?.done }}
        role={node()?.todo ? 'checkbox' : undefined}
        aria-checked={node()?.todo ? !!node()?.done : undefined}
        // No default on mousedown: DOM focus stays in the row being edited.
        onMouseDown={(e) => e.preventDefault()}
        // A held finger is a drag, not the browser's context menu.
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => !o.readOnly ? props.grab(e, id) : e.button === 0 && !node()?.todo && o.zoomTo(id)}
      />
      <div class="body">
        <Show
          when={editingText()}
          fallback={
            <div class="text" onMouseDown={onStaticMouseDown(false)}>
              <Pieces o={o} pieces={pieces()} />
            </div>
          }
        >
          <Editable o={o} id={id} />
        </Show>
        <Show
          when={editingNote()}
          fallback={
            <Show when={node()?.note}>
              <div class="note" onMouseDown={onStaticMouseDown(true)}>
                <Pieces o={o} pieces={notePieces()} />
              </div>
            </Show>
          }
        >
          <NoteEditable o={o} id={id} />
        </Show>
      </div>
    </div>
  );
}

/**
 * `/time` typed before the caret becomes the current time. While a word is
 * being composed (Android keyboards compose every word) the text must not be
 * touched, so there the check waits for the composition to end.
 */
const timeCommand = (o: Outliner, id: NodeId, el: HTMLElement, text: string, note: boolean) => {
  const caret = selectionIn(el)?.[0];
  if (caret === undefined || !timeCommandBefore(text, caret)) return;
  o.insert(note ? { id, caret, note: true } : { id, caret }, timeOfDay(), TIME_COMMAND.length);
};

// Undo/redo from the browser's menu bypasses keydown.
const historyInput = (o: Outliner) => (e: InputEvent) => {
  if (e.inputType === 'historyUndo') {
    e.preventDefault();
    o.undo();
  } else if (e.inputType === 'historyRedo') {
    e.preventDefault();
    o.redo();
  }
};

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
function Editable(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  let el!: HTMLDivElement;
  const text = () => {
    o.nodes.track(id);
    return o.doc.nodes.get(id)?.text ?? '';
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
    o.type(id, el.textContent ?? '');
    if (!e.isComposing) timeCommand(o, id, el, el.textContent ?? '', false);
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = e.clipboardData?.getData('text/plain');
    if (pasted == null) return;
    e.preventDefault();
    const [start, end] = selectionIn(el) ?? [0, 0];
    // Several lines: an indented list (Markdown, Workflowy, plain) becomes a tree.
    if (/[\r\n]/.test(pasted)) o.run((ctx) => cmd.insertTrees(ctx, id, start, end, parseIndented(pasted)));
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
      onBeforeInput={historyInput(o)}
    />
  );
}

/**
 * The note under the focused row, editable. Unlike the text it spans lines:
 * Enter starts a new line; Shift+Enter or Esc go back to the text.
 */
function NoteEditable(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  let el!: HTMLDivElement;
  const note = () => {
    o.nodes.track(id);
    return o.doc.nodes.get(id)?.note ?? '';
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
    o.typeNote(id, read());
    if (!e.isComposing) timeCommand(o, id, el, read(), true);
  };

  return (
    <div
      ref={el}
      class="note"
      contentEditable="plaintext-only"
      onKeyDown={(e) => suggestKey(e) || onNoteKeyDown(e, o, id, el)}
      onInput={onInput}
      onCompositionEnd={() => timeCommand(o, id, el, read(), true)}
      onBeforeInput={historyInput(o)}
    />
  );
}
