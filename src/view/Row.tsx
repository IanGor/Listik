import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import * as cmd from '../model/commands';
import { parseIndented } from '../model/outline-text';
import { decorate, type Piece } from '../model/search';
import type { NodeId } from '../model/types';
import { lineHeight, offsetFromPoint, selectionIn, setCaret } from './caret';
import { onEditorKeyDown, onNoteKeyDown } from './keymap';
import type { FocusRequest, Outliner } from './outliner';

interface RowProps {
  o: Outliner;
  /** Fixed for the component's lifetime: rows are keyed by id. */
  id: NodeId;
  depth: number;
  /** Starts measuring the row element; returns the stop function. */
  observe: (el: HTMLElement) => () => void;
}

const inNote = (f: FocusRequest | null) => !!f && 'note' in f && !!f.note;

/** Tags and search hits within a text, as rendered spans. */
function Pieces(props: { o: Outliner; pieces: Piece[] }) {
  return (
    <For each={props.pieces}>
      {(p) => p.tag
        ? <span class="tag" classList={{ active: !!props.o.filter()?.query.tags.includes(p.tag), hit: !!p.hit }} data-tag={p.tag}>{p.text}</span>
        : p.hit ? <mark>{p.text}</mark> : p.text}
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
  onMount(() => onCleanup(props.observe(el)));
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
    if (o.readOnly) return;
    const caret = offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    const length = (note ? node()?.note : node()?.text)?.length ?? 0;
    o.setFocus(note ? { id, caret: caret ?? length, note: true } : { id, caret: caret ?? length });
  };

  // Mousedown, not click, and no default: DOM focus stays in the row being edited.
  const onBulletMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (node()) o.zoomTo(id);
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
      classList={{ done: !!node()?.done }}
      data-id={id}
      data-depth={props.depth}
      style={{ 'padding-left': `calc(var(--indent) * ${props.depth})`, '--depth': String(props.depth) }}
    >
      <Show when={hasChildren()}>
        <span class="toggle" classList={{ open: open() }} onMouseDown={onToggleMouseDown} aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor"><path d="M3 1.5 7.5 5 3 8.5z" /></svg>
        </span>
      </Show>
      <span class="bullet" classList={{ collapsed: folded() }} onMouseDown={onBulletMouseDown} />
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

  const onInput = () => {
    const t = el.textContent ?? '';
    if (el.childNodes.length > 1 || el.firstElementChild || t.includes('\n')) {
      const caret = selectionIn(el)?.[0] ?? t.length;
      el.textContent = t.replace(/\n/g, ' ');
      setCaret(el, caret);
    }
    o.type(id, el.textContent ?? '');
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
      onKeyDown={(e) => onEditorKeyDown(e, o, id, el)}
      onInput={onInput}
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

  const onInput = () => {
    // Other browsers may insert <br> for a new line: turn it back into text.
    if (el.querySelector('br')) {
      const caret = selectionIn(el)?.[0];
      write(el.innerText.replace(/\n$/, ''));
      if (caret !== undefined) setCaret(el, caret);
    }
    o.typeNote(id, read());
  };

  return (
    <div
      ref={el}
      class="note"
      contentEditable="plaintext-only"
      onKeyDown={(e) => onNoteKeyDown(e, o, id, el)}
      onInput={onInput}
      onBeforeInput={historyInput(o)}
    />
  );
}
