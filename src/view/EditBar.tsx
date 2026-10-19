import { For, Show, createEffect, createSignal, on } from 'solid-js';
import * as cmd from '../model/commands';
import { timeOfDay } from '../model/time';
import type { Focus } from '../model/types';
import { selectionIn } from './caret';
import { formatSelection } from './keymap';
import type { Outliner } from './outliner';
import { keyboard, touch } from './screen';

interface Action {
  label: string;
  /** SVG paths of its icon, drawn by `Icon`. */
  icon: string[];
  run: (o: Outliner, here: Focus) => void;
  /** For the zoom title too (`here.id` is then the zoomed-in bullet), and how, if not as for a row. */
  title?: true | ((o: Outliner, here: Focus) => void);
}

/** What the formatting set offers: bold or italic around the selection (Ctrl+B / Ctrl+I). */
const FORMATS = [
  { label: 'Жирный', icon: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'], marker: '**', class: 'md-bold' },
  { label: 'Курсив', icon: ['M10 5h8', 'M6 19h8', 'M15 5l-6 14'], marker: '*', class: 'md-italic' },
] as const;

/** The button that brings the formatting set in: a drawn "T". */
const FORMAT_ICON = ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'];

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
      if (o.isMirror(h.id)) return o.mirrorReadOnly();
      const n = o.contentOf(h.id);
      o.setFocus(h.note ? { id: h.id, caret: n.text.length } : { id: h.id, caret: n.note.length, note: true });
    },
    // In the zoom title: to its note (made if there is none) and back.
    title: (o, h) => {
      const n = o.doc.get(h.id);
      o.editTitle(h.note ? { note: false, caret: n.text.length } : { note: true, caret: n.note.length });
    },
  },
  { label: 'Вставить время', icon: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M12 7v5l3 2'], run: (o, h) => o.insert(h, timeOfDay()), title: true },
  { label: 'Отменить', icon: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'], run: (o) => o.undo(), title: true },
  { label: 'Повторить', icon: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'], run: (o) => o.redo(), title: true },
];

/**
 * A bar of editing actions at the bottom of a touch screen while a bullet is
 * edited and the on-screen keyboard is up: the keyboard has no Tab,
 * Ctrl+L or Ctrl+Z. Hidden with the keyboard, even if the row is still
 * being edited. It sits in the page's flow, so it rests right on the keyboard
 * (index.html). Its buttons never take focus: the keyboard stays open.
 *
 * Two sets share its place. "Оформление" slides the main set out to the left
 * and the formatting set in from the right; picking a format, or "Назад",
 * slides back. Another bullet always starts on the main set.
 *
 * In the zoom title (or its note) the bar offers what applies there: the
 * note, formatting, the time, undo and redo.
 */
export function EditBar(props: { o: Outliner }) {
  const o = props.o;

  /** The zoom title or its note is being edited, not a row. */
  const inTitle = () => !o.focus() && !!o.titleEdit() && o.zoom() !== null;

  /** Where the caret is now: the command keeps it there, and undo returns to it. */
  const here = (): Focus | null => {
    const el = document.activeElement as HTMLElement | null;
    const caret = el?.isContentEditable ? (selectionIn(el)?.[0] ?? 0) : 0;
    const f = o.focus();
    if (f) return 'note' in f && f.note ? { id: f.id, caret, note: true } : { id: f.id, caret };
    const t = o.titleEdit();
    const z = o.zoom();
    if (!t || !z) return null;
    return t.note ? { id: z, caret, note: true } : { id: z, caret };
  };

  const [formatting, setFormatting] = createSignal(false);
  createEffect(on(() => o.focus()?.id ?? o.titleEdit()?.note, () => setFormatting(false)));

  const press = (action: Action) => {
    const h = here();
    if (!h) return;
    if (inTitle()) return typeof action.title === 'function' ? action.title(o, h) : action.run(o, h);
    action.run(o, h);
  };

  /** The main set: everything for a row, what applies for the title. */
  const actions = () => (inTitle() ? ACTIONS.filter((a) => a.title) : ACTIONS);
  /** Where "Оформление" goes among them: after the note. */
  const split = () => actions().findIndex((a) => a.label === 'Заметка') + 1;

  const format = (marker: '**' | '*') => {
    const h = here();
    const el = document.activeElement as HTMLElement | null;
    if (h && el?.isContentEditable) formatSelection(o, h.id, el, !!h.note, marker);
    setFormatting(false);
  };

  const button = (label: string, icon: string[], onClick: () => void) => (
    <button type="button" tabIndex={-1} title={label} aria-label={label} onClick={onClick}>
      <Icon paths={icon} />
    </button>
  );

  return (
    <Show when={touch() && keyboard() && !o.readOnly && (o.focus() || inTitle())}>
      <div class="editbar" role="toolbar" aria-label="Правка пункта" onMouseDown={(e) => e.preventDefault()}>
        <div class="editbar-set editbar-main" inert={formatting()}>
          <For each={actions().slice(0, split())}>{(a) => button(a.label, a.icon, () => press(a))}</For>
          {button('Оформление', FORMAT_ICON, () => setFormatting(true))}
          <For each={actions().slice(split())}>{(a) => button(a.label, a.icon, () => press(a))}</For>
        </div>
        <div class="editbar-set editbar-format" inert={!formatting()}>
          {button('Назад', ['M15 6l-6 6 6 6'], () => setFormatting(false))}
          <For each={FORMATS}>
            {(f) => (
              <button type="button" tabIndex={-1} class="editbar-labelled" aria-label={f.label} onClick={() => format(f.marker)}>
                <Icon paths={[...f.icon]} />
                <span class={f.class}>{f.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
