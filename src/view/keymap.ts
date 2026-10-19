import * as cmd from '../model/commands';
import { markdownOf } from '../model/outline-text';
import { nodeOf, type RowKey } from '../model/rows';
import { caretOnFirstLine, caretOnLastLine, caretX, selectRange, selectionIn } from './caret';
import type { Outliner } from './outliner';
import { touch } from './screen';

/**
 * Ctrl+B / Ctrl+I in a bullet's text or note (by physical key, any layout):
 * bold or italic around the selection, which stays selected. Returns whether
 * the key was one of them.
 */
export function formatKeys(e: KeyboardEvent, o: Outliner, id: RowKey, el: HTMLElement, note: boolean): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.code !== 'KeyB' && e.code !== 'KeyI')) return false;
  e.preventDefault();
  formatSelection(o, id, el, note, e.code === 'KeyB' ? '**' : '*');
  return true;
}

/** Bold or italic around the selection in `el`, the bullet's text or note editor; the selection stays on the words. */
export function formatSelection(o: Outliner, id: RowKey, el: HTMLElement, note: boolean, marker: '**' | '*'): void {
  const [start, end] = selectionIn(el) ?? [0, 0];
  const r = o.format(note ? { id, note: true } : { id }, start, end, marker);
  if (r) selectRange(el, r.start, r.end);
}

/** Keyboard handling for the row being edited (`el` is its contenteditable). */
export function onEditorKeyDown(e: KeyboardEvent, o: Outliner, id: RowKey, el: HTMLElement): void {
  if (e.isComposing || formatKeys(e, o, id, el, false)) return;
  const mod = e.ctrlKey || e.metaKey;
  const [start, end] = selectionIn(el) ?? [0, 0];
  const collapsed = start === end;
  const here = { id, caret: start };
  const handle = (fn: () => void) => {
    e.preventDefault();
    fn();
  };

  // Ctrl/Cmd+L (by physical key): task on, checked, unchecked; with Shift, a plain bullet again.
  if (mod && !e.altKey && e.code === 'KeyL') return handle(() => (e.shiftKey ? o.untask([id], here) : o.cycleTask([id], here)));

  switch (e.key) {
    // Enter splits; Shift+Enter goes to the note. Ctrl+Enter, the old task key, does nothing.
    case 'Enter':
      return handle(() => {
        if (mod) return;
        if (e.shiftKey) return o.setFocus({ id, caret: o.contentOf(id).note.length, note: true });
        o.run((ctx) => {
          const text = ctx.doc.content(nodeOf(id)).text;
          if (!collapsed) cmd.setText(ctx, id, text.slice(0, start) + text.slice(end));
          return cmd.split(ctx, id, start);
        });
      });

    case 'Tab':
      return handle(() => o.run((ctx) => (e.shiftKey ? cmd.outdent : cmd.indent)(ctx, id), here));

    case 'Backspace':
      if (mod && e.shiftKey) return handle(() => o.run((ctx) => cmd.deleteNode(ctx, id)));
      if (!collapsed || start !== 0) return;
      // On a touch screen a held Backspace runs on into the bullet above:
      // there it only removes an empty bullet, never joins two texts.
      if (touch() && o.contentOf(id).text) return;
      return handle(() => o.run((ctx) => cmd.mergeUp(ctx, id), here));

    case 'Delete': {
      if (!collapsed || start !== o.contentOf(id).text.length) return;
      const next = o.rows.ids[o.rows.indexOf(id) + 1];
      if (next) handle(() => o.run((ctx) => cmd.mergeUp(ctx, next), here));
      return;
    }

    // Alt+→ / Alt+←: zoom into this bullet / out of the current one.
    case 'ArrowRight':
    case 'ArrowLeft':
      if (!e.altKey || e.shiftKey || mod) return;
      return handle(() => (e.key === 'ArrowRight' ? o.zoomIn(id) : o.zoomOut()));

    case 'ArrowUp':
    case 'ArrowDown': {
      const up = e.key === 'ArrowUp';
      if ((mod || e.altKey) && e.shiftKey) {
        return handle(() => o.run((ctx) => (up ? cmd.moveUp : cmd.moveDown)(ctx, id), here));
      }
      if (mod) return handle(() => o.fold(id, up, here));
      // Shift+↑/↓ past the text's edge starts selecting bullets: this one and the next.
      if (e.shiftKey && !e.altKey && collapsed && (up ? caretOnFirstLine(el) : caretOnLastLine(el))) {
        const next = o.rows.ids[o.rows.indexOf(id) + (up ? -1 : 1)];
        return handle(() => {
          el.blur();
          o.select({ anchor: id, head: next ?? id });
        });
      }
      if (e.shiftKey || e.altKey) return;
      if (up ? !caretOnFirstLine(el) : !caretOnLastLine(el)) return;
      // Down from the text goes into its note first, if there is one.
      if (!up && o.contentOf(id).note) return handle(() => o.setFocus({ id, x: caretX(el), line: 'first', note: true }));
      const i = o.rows.indexOf(id) + (up ? -1 : 1);
      if (i < 0 || i >= o.rows.length) return;
      const target = o.rows.ids[i];
      // Up into a row with a note lands on the note's last line.
      const note = up && o.contentOf(target).note ? ({ note: true } as const) : {};
      return handle(() => o.setFocus({ id: target, x: caretX(el), line: up ? 'last' : 'first', ...note }));
    }

    // First Esc clears the search (editing goes on, now in context); the next one leaves editing.
    case 'Escape':
      return handle(() => {
        if (o.query() || o.filter()) return o.setQuery('', true);
        o.setFocus(null);
        el.blur();
      });
  }

  onGlobalKeys(e, o);
}

/**
 * Keys while bullets are selected (no row is being edited). Returns whether
 * the key was handled. Commands act on the selection's roots, each as one
 * undo step.
 */
export function onSelectionKeys(e: KeyboardEvent, o: Outliner): boolean {
  const selection = o.selection();
  if (!selection) return false;
  const mod = e.ctrlKey || e.metaKey;
  const roots = () => o.selectionRoots();
  const handle = (fn: () => void) => {
    e.preventDefault();
    fn();
    return true;
  };
  const copy = () => navigator.clipboard?.writeText(markdownOf(o.doc, roots().map(nodeOf))).catch(() => o.notify('Не удалось скопировать'));

  switch (e.key) {
    case 'Escape':
      return handle(() => o.select(null));
    case 'ArrowUp':
    case 'ArrowDown': {
      const up = e.key === 'ArrowUp';
      if ((mod || e.altKey) && e.shiftKey) return handle(() => o.run((ctx) => (up ? cmd.moveUpMany : cmd.moveDownMany)(ctx, roots())));
      if (e.shiftKey) return handle(() => o.extendSelection(up ? -1 : 1));
      return handle(() => o.setFocus({ id: selection.head, caret: 0 }));
    }
    case 'Tab':
      return handle(() => o.run((ctx) => (e.shiftKey ? cmd.outdentMany : cmd.indentMany)(ctx, roots())));
    case 'Backspace':
    case 'Delete':
      return handle(() => o.run((ctx) => cmd.deleteMany(ctx, roots())));
    case 'Enter':
      if (mod) return handle(() => {});
      return handle(() => o.setFocus({ id: selection.head, caret: o.contentOf(selection.head).text.length }));
  }
  if (mod && !e.altKey && e.code === 'KeyL') return handle(() => (e.shiftKey ? o.untask(roots()) : o.cycleTask(roots())));
  if (mod && e.code === 'KeyC') return handle(() => void copy());
  if (mod && e.code === 'KeyX') {
    return handle(() => {
      void copy();
      o.run((ctx) => cmd.deleteMany(ctx, roots()));
    });
  }
  if (mod && e.code === 'KeyA') {
    return handle(() => o.select({ anchor: o.rows.ids[0], head: o.rows.ids[o.rows.length - 1] }));
  }
  return false;
}

/** Keyboard handling in a bullet's note: Enter makes a new line; the rest leads back out. */
export function onNoteKeyDown(e: KeyboardEvent, o: Outliner, id: RowKey, el: HTMLElement): void {
  if (e.isComposing || formatKeys(e, o, id, el, true)) return;
  const mod = e.ctrlKey || e.metaKey;
  const [start, end] = selectionIn(el) ?? [0, 0];
  const toText = () => o.setFocus({ id, caret: o.contentOf(id).text.length });
  const handle = (fn: () => void) => {
    e.preventDefault();
    fn();
  };
  if (mod && !e.altKey && e.code === 'KeyL') {
    const here = { id, caret: start, note: true } as const;
    return handle(() => (e.shiftKey ? o.untask([id], here) : o.cycleTask([id], here)));
  }
  if (e.key === 'Enter' && mod) return handle(() => {});
  if ((e.key === 'Enter' && e.shiftKey) || e.key === 'Escape') return handle(toText);
  if (e.key === 'Backspace' && start === 0 && end === 0 && !el.textContent) return handle(toText);
  if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !mod && caretOnFirstLine(el)) {
    return handle(() => o.setFocus({ id, x: caretX(el), line: 'last' }));
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !mod && caretOnLastLine(el)) {
    const next = o.rows.ids[o.rows.indexOf(id) + 1];
    if (next) return handle(() => o.setFocus({ id: next, x: caretX(el), line: 'first' }));
    return;
  }
  onGlobalKeys(e, o);
}

/**
 * Keys that work wherever the caret is in the outline: Ctrl/Cmd+Z,
 * Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, and Ctrl/Cmd+F for search (the browser's
 * own find cannot see virtualized rows). Matched by physical key, so they
 * work in any keyboard layout. The browser's own undo never runs: it would
 * desync the DOM from the model.
 */
export function onGlobalKeys(e: KeyboardEvent, o: Outliner): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.code === 'KeyF') {
    e.preventDefault();
    o.requestSearch();
  } else if (e.code === 'Slash') {
    e.preventDefault();
    o.showHelp();
  } else if (e.code === 'KeyO') {
    e.preventDefault();
    o.toggleShowDone();
  } else if (e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) o.redo();
    else o.undo();
  } else if (e.code === 'KeyY') {
    e.preventDefault();
    o.redo();
  }
}
