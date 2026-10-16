import { Show, createEffect, on, onCleanup, onMount } from 'solid-js';
import * as cmd from '../model/commands';
import type { NodeId } from '../model/types';
import { lineHeight, offsetFromPoint, selectionIn, setCaret } from './caret';
import { onEditorKeyDown } from './keymap';
import type { Outliner } from './outliner';

interface RowProps {
  o: Outliner;
  /** Fixed for the component's lifetime: rows are keyed by id. */
  id: NodeId;
  depth: number;
  /** Starts measuring the row element; returns the stop function. */
  observe: (el: HTMLElement) => () => void;
}

/**
 * One bullet. Renders static text, except for the focused row, which becomes
 * an editable element (see Editable).
 */
export function Row(props: RowProps) {
  const o = props.o;
  const id = props.id;
  let el!: HTMLDivElement;
  onMount(() => onCleanup(props.observe(el)));
  onCleanup(() => o.nodes.release(id));

  const node = () => {
    o.nodes.track(id);
    return o.doc.nodes.get(id);
  };
  const editing = () => o.focus()?.id === id;
  const collapsed = () => {
    const n = node();
    return !!n && n.collapsed && n.children.length > 0;
  };

  const onTextMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const caret = offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    o.setFocus({ id, caret: caret ?? node()?.text.length ?? 0 });
  };

  const onBulletMouseDown = (e: MouseEvent) => {
    // Keep DOM focus in the row being edited.
    e.preventDefault();
    const n = node();
    if (n) o.run((ctx) => cmd.setCollapsed(ctx, id, !n.collapsed));
  };

  return (
    <div ref={el} class="row" data-id={id} data-depth={props.depth} style={{ 'padding-left': `calc(var(--indent) * ${props.depth})` }}>
      <span class="bullet" classList={{ collapsed: collapsed() }} onMouseDown={onBulletMouseDown}>•</span>
      <Show when={editing()} fallback={<div class="text" onMouseDown={onTextMouseDown}>{node()?.text}</div>}>
        <Editable o={o} id={id} />
      </Show>
    </div>
  );
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
    if (f?.id !== id) return;
    el.focus({ preventScroll: true });
    const len = el.textContent?.length ?? 0;
    if ('caret' in f) return setCaret(el, Math.min(f.caret, len));
    const r = el.getBoundingClientRect();
    const half = lineHeight(el) / 2;
    const y = f.line === 'first' ? r.top + half : r.bottom - half;
    setCaret(el, offsetFromPoint(el, f.x, y) ?? (f.line === 'first' ? 0 : len));
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
    const lines = pasted.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const [start, end] = selectionIn(el) ?? [0, 0];
    o.run((ctx) => cmd.insertText(ctx, id, start, end, lines));
  };

  // Undo/redo from the browser's menu bypasses keydown.
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      o.undo();
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      o.redo();
    }
  };

  return (
    <div
      ref={el}
      class="text"
      contentEditable="plaintext-only"
      onKeyDown={(e) => onEditorKeyDown(e, o, id, el)}
      onInput={onInput}
      onPaste={onPaste}
      onBeforeInput={onBeforeInput}
    />
  );
}
