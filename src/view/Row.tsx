import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import * as cmd from '../model/commands';
import { closesLink, opensLink } from '../model/links';
import { closesMirror, opensMirror } from '../model/mirrors';
import { parseIndented } from '../model/outline-text';
import { nodeOf, type RowKey } from '../model/rows';
import { decorate, type Piece } from '../model/search';
import { TIME_COMMAND, timeCommandBefore, timeOfDay } from '../model/time';
import { lineHeight, offsetFromPoint, offsetNear, selectRange, selectionIn, setCaret } from './caret';
import { onEditorKeyDown, onNoteKeyDown } from './keymap';
import type { FocusRequest, Outliner } from './outliner';
import { suggestKey } from './Suggest';

interface RowProps {
  o: Outliner;
  /** The row's key, fixed for the component's lifetime (model/rows.ts: under a mirror, not the bullet's id). */
  id: RowKey;
  depth: number;
  /** Starts measuring the row element; returns the stop function. */
  observe: (el: HTMLElement) => () => void;
  /** A press on the bullet: a click zooms in, a drag moves (drag.ts). */
  grab: (e: PointerEvent, id: RowKey) => void;
}

const inNote = (f: FocusRequest | null) => !!f && 'note' in f && !!f.note;

/**
 * Tags, search hits, bold and italic within a text, as rendered spans.
 * Formatting markers stay in the DOM, hidden, so offsets in the element
 * are offsets in the text (a click puts the caret where it belongs).
 */
export function Pieces(props: { o: Outliner; pieces: Piece[] }) {
  return (
    <For each={props.pieces}>
      {(p) => {
        if (p.marker) return <span class="md-marker">{p.text}</span>;
        const plain = p.hit ? <mark>{p.text}</mark> : p.text;
        const inner = p.link !== undefined
          ? <span class="link" data-link={p.link}>{plain}</span>
          : p.tag
            ? <span class="tag" classList={{ active: !!props.o.filter()?.query.tags.some((t) => p.tag!.startsWith(t)), hit: !!p.hit }} data-tag={p.tag}>{p.text}</span>
            : plain;
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
  const nid = nodeOf(id);
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
  const mirror = () => !!node()?.mirrorOf;
  const orphan = () => mirror() && !o.doc.nodes.has(node()!.mirrorOf!);
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
    return !!content() && o.rows.showsChildren(id);
  };
  const terms = () => o.filter()?.query.terms ?? [];
  const pieces = createMemo(() => decorate(content()?.text ?? '', terms()));
  const notePieces = createMemo(() => decorate(content()?.note ?? '', terms()));

  /** A click in static text: a tag filters, a link leads to its bullet, anything else puts the caret there. */
  const onStaticMouseDown = (note: boolean) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const tag = target.dataset.tag;
    if (tag) return o.filterByTag(tag);
    const link = target.closest<HTMLElement>('[data-link]')?.dataset.link;
    if (link !== undefined) return o.followLink(link);
    // Shift+click selects the rows from the edited (or already selected) one to here.
    const anchor = o.selection()?.anchor ?? o.focus()?.id;
    if (e.shiftKey && anchor) {
      (document.activeElement as HTMLElement | null)?.blur();
      return o.select({ anchor, head: id });
    }
    if (o.readOnly) return;
    const caret = offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    const length = (note ? content()?.note : content()?.text)?.length ?? 0;
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
      classList={{ done: !!content()?.done, mirror: mirror(), orphan: orphan(), selected: o.selectedSet().has(id), dragged: o.dragged().has(id) }}
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
        classList={{ collapsed: folded(), todo: !!content()?.todo, checked: !!content()?.done, mirror: mirror() }}
        role={content()?.todo ? 'checkbox' : undefined}
        aria-checked={content()?.todo ? !!content()?.done : undefined}
        title={mirror() ? 'Зеркало: тот же пункт в другом месте; точка ведёт к оригиналу' : undefined}
        // No default on mousedown: DOM focus stays in the row being edited.
        onMouseDown={(e) => e.preventDefault()}
        // A held finger is a drag, not the browser's context menu.
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => !o.readOnly ? props.grab(e, id) : e.button === 0 && !content()?.todo && o.zoomTo(id)}
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
            <Show when={content()?.note}>
              {/* Its first lines only (NOTE_LINES), all of them while the row is edited. */}
              <div class="note" classList={{ clamped: !focused() }} onMouseDown={onStaticMouseDown(true)}>
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
const timeCommand = (o: Outliner, id: RowKey, el: HTMLElement, text: string, note: boolean) => {
  const caret = selectionIn(el)?.[0];
  if (caret === undefined || !timeCommandBefore(text, caret)) return;
  o.insert(note ? { id, caret, note: true } : { id, caret }, timeOfDay(), TIME_COMMAND.length);
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
 * keydown), no edits on a mirror's heading, `]` stepping over a link's closing bracket, Backspace taking out
 * an empty `[]` pair whole. `read`/`write` give the element's text.
 */
function beforeInput(e: InputEvent, o: Outliner, id: RowKey, el: HTMLElement, read: () => string, write: (t: string) => void, save: (t: string) => void): void {
  if (e.inputType === 'historyUndo') {
    e.preventDefault();
    return o.undo();
  }
  if (e.inputType === 'historyRedo') {
    e.preventDefault();
    return o.redo();
  }
  // A mirror's heading takes no edits (model/commands.ts); what cannot be refused here, `restore` puts back.
  if (o.isMirror(id)) {
    if (e.cancelable) e.preventDefault();
    return o.mirrorReadOnly();
  }
  if (e.isComposing || !e.cancelable) return;
  const sel = selectionIn(el);
  if (!sel || sel[0] !== sel[1]) return;
  const caret = sel[0];
  const text = read();
  if (e.inputType === 'insertText' && ((e.data === ']' && closesLink(text, caret)) || (e.data === ')' && closesMirror(text, caret)))) {
    e.preventDefault();
    setCaret(el, caret + 1);
  } else if (e.inputType === 'deleteContentBackward' && ((text[caret - 1] === '[' && text[caret] === ']') || (text[caret - 1] === '(' && text[caret] === ')'))) {
    e.preventDefault();
    const next = text.slice(0, caret - 1) + text.slice(caret + 1);
    write(next);
    setCaret(el, caret - 1);
    save(next);
  }
}

/** An edit the browser made anyway (a composing keyboard) in a mirror's heading: the DOM goes back to the model. */
function restore(el: HTMLElement, text: string): void {
  const caret = selectionIn(el)?.[0];
  el.textContent = text;
  setCaret(el, Math.min(caret ?? 0, text.length));
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
    if (o.isMirror(id)) return restore(el, text());
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
    if (o.isMirror(id)) return o.mirrorReadOnly();
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
      onBeforeInput={(e) => beforeInput(e, o, id, el, () => el.textContent ?? '', (t) => (el.textContent = t), (t) => o.type(id, t))}
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
    if (o.isMirror(id)) return restore(el, note().endsWith('\n') ? `${note()}\n` : note());
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
      onCompositionEnd={() => timeCommand(o, id, el, read(), true)}
      onBeforeInput={(e) => beforeInput(e, o, id, el, read, write, (t) => o.typeNote(id, t))}
    />
  );
}
