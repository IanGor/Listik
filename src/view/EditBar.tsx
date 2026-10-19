import { For, Show } from 'solid-js';
import * as cmd from '../model/commands';
import type { Focus } from '../model/types';
import { selectionIn } from './caret';
import type { Outliner } from './outliner';
import { touch } from './screen';

interface Action {
  label: string;
  /** SVG paths of its icon, drawn by `Icon`. */
  icon: string[];
  run: (o: Outliner, here: Focus) => void;
}

function Icon(props: { paths: string[] }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <For each={props.paths}>{(d) => <path d={d} />}</For>
    </svg>
  );
}

/** What the keyboard does on a computer (keymap.ts), for a touch screen. */
const ACTIONS: Action[] = [
  { label: 'Вынести', icon: ['M4 6v12', 'M20 12H9', 'M13 8l-4 4 4 4'], run: (o, h) => o.run((ctx) => cmd.outdent(ctx, h.id), h) },
  { label: 'Вложить', icon: ['M20 6v12', 'M4 12h11', 'M11 8l4 4-4 4'], run: (o, h) => o.run((ctx) => cmd.indent(ctx, h.id), h) },
  { label: 'Переместить вверх', icon: ['M12 19V5', 'M6 11l6-6 6 6'], run: (o, h) => o.run((ctx) => cmd.moveUp(ctx, h.id), h) },
  { label: 'Переместить вниз', icon: ['M12 5v14', 'M6 13l6 6 6-6'], run: (o, h) => o.run((ctx) => cmd.moveDown(ctx, h.id), h) },
  { label: 'Задача: сделать, отметить, снять отметку', icon: ['M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z', 'M8.5 12.5l2.5 2.5 4.5-5'], run: (o, h) => o.cycleTask([h.id], h) },
  {
    label: 'Заметка',
    icon: ['M5 7h14', 'M5 12h14', 'M5 17h8'],
    run: (o, h) => {
      const n = o.doc.get(h.id);
      o.setFocus(h.note ? { id: h.id, caret: n.text.length } : { id: h.id, caret: n.note.length, note: true });
    },
  },
  { label: 'Отменить', icon: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'], run: (o) => o.undo() },
  { label: 'Повторить', icon: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'], run: (o) => o.redo() },
];

/**
 * A bar of editing actions at the bottom of a touch screen while a bullet is
 * edited: an on-screen keyboard has no Tab, Ctrl+Enter or Ctrl+Z. It sits in
 * the page's flow, so with the keyboard up (index.html) it rests right on it.
 * Its buttons never take focus: the keyboard stays open.
 */
export function EditBar(props: { o: Outliner }) {
  const o = props.o;

  /** Where the caret is now: the command keeps it there, and undo returns to it. */
  const here = (): Focus | null => {
    const f = o.focus();
    if (!f) return null;
    const el = document.activeElement as HTMLElement | null;
    const caret = el?.isContentEditable ? (selectionIn(el)?.[0] ?? 0) : 0;
    return 'note' in f && f.note ? { id: f.id, caret, note: true } : { id: f.id, caret };
  };

  const press = (action: Action) => {
    const h = here();
    if (h) action.run(o, h);
  };

  return (
    <Show when={touch() && !o.readOnly && o.focus()}>
      <div class="editbar" role="toolbar" aria-label="Правка пункта" onMouseDown={(e) => e.preventDefault()}>
        <For each={ACTIONS}>
          {(a) => (
            <button type="button" tabIndex={-1} title={a.label} aria-label={a.label} onClick={() => press(a)}>
              <Icon paths={a.icon} />
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
