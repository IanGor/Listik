import * as cmd from '../model/commands';
import type { NodeId } from '../model/types';
import { caretOnFirstLine, caretOnLastLine, caretX, selectionIn } from './caret';
import type { Outliner } from './outliner';

/** Keyboard handling for the row being edited (`el` is its contenteditable). */
export function onEditorKeyDown(e: KeyboardEvent, o: Outliner, id: NodeId, el: HTMLElement): void {
  if (e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  const [start, end] = selectionIn(el) ?? [0, 0];
  const collapsed = start === end;
  const here = { id, caret: start };
  const handle = (fn: () => void) => {
    e.preventDefault();
    fn();
  };

  switch (e.key) {
    case 'Enter':
      // Shift+Enter would insert a newline; bullets are single-line for now.
      return handle(() => {
        if (e.shiftKey) return;
        o.run((ctx) => {
          const text = ctx.doc.get(id).text;
          if (!collapsed) cmd.setText(ctx, id, text.slice(0, start) + text.slice(end));
          return cmd.split(ctx, id, start);
        });
      });

    case 'Tab':
      return handle(() => o.run((ctx) => (e.shiftKey ? cmd.outdent : cmd.indent)(ctx, id), here));

    case 'Backspace':
      if (mod && e.shiftKey) return handle(() => o.run((ctx) => cmd.deleteNode(ctx, id)));
      if (collapsed && start === 0) return handle(() => o.run((ctx) => cmd.mergeUp(ctx, id), here));
      return;

    case 'Delete': {
      if (!collapsed || start !== o.doc.get(id).text.length) return;
      const next = o.rows.ids[o.rows.indexOf(id) + 1];
      if (next) handle(() => o.run((ctx) => cmd.mergeUp(ctx, next), here));
      return;
    }

    case 'ArrowUp':
    case 'ArrowDown': {
      const up = e.key === 'ArrowUp';
      if ((mod || e.altKey) && e.shiftKey) {
        return handle(() => o.run((ctx) => (up ? cmd.moveUp : cmd.moveDown)(ctx, id), here));
      }
      if (mod) return handle(() => o.run((ctx) => cmd.setCollapsed(ctx, id, up), here));
      if (e.shiftKey || e.altKey) return;
      if (up ? !caretOnFirstLine(el) : !caretOnLastLine(el)) return;
      const i = o.rows.indexOf(id) + (up ? -1 : 1);
      if (i < 0 || i >= o.rows.length) return;
      return handle(() => o.setFocus({ id: o.rows.ids[i], x: caretX(el), line: up ? 'last' : 'first' }));
    }

    case 'Escape':
      return handle(() => {
        o.setFocus(null);
        el.blur();
      });
  }

  // Native undo would desync the DOM from the model; app-level undo comes with history (M2).
  if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) e.preventDefault();
}
