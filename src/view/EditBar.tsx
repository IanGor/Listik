import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import * as cmd from '../model/commands';
import { timeOfDay } from '../model/time';
import type { Focus } from '../model/types';
import { selectionIn } from './caret';
import { formatSelection } from './keymap';
import type { Outliner } from './outliner';
import { keyboard, touch } from './screen';

/** Which set the bar shows: the main one, or one of the sets it leads to. */
type SetName = 'main' | 'move' | 'insert' | 'format';

interface Action {
  label: string;
  /** SVG paths of its icon, drawn by `Icon`. */
  icon: string[];
  run: (o: Outliner, here: Focus) => void;
  /** For the zoom title too (`here.id` is then the zoomed-in bullet), and how, if not as for a row. */
  title?: true | ((o: Outliner, here: Focus) => void);
  /** A set this button opens instead of running (`run` is then unused). */
  opens?: Exclude<SetName, 'main'>;
}

/** A button of a set: an icon or a glyph, and its name written out. */
interface Item {
  label: string;
  icon?: string[];
  /** Drawn instead of an icon: the brackets typed. */
  glyph?: string;
  /** Class of the written name: a format shows in its own style. */
  class?: string;
  run: (o: Outliner, here: Focus, el: HTMLElement | null) => void;
  /** Not offered here (greyed out): a mirror is a bullet, not text in a note. */
  off?: (here: Focus) => boolean;
}

interface SubSet {
  name: Exclude<SetName, 'main'>;
  label: string;
  items: Item[];
  /** Stays after a press, for a run of them (moving a bullet up three places); others go back to the main set. */
  stays?: true;
}

function Icon(props: { paths: string[] }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <For each={props.paths}>{(d) => <path d={d} />}</For>
    </svg>
  );
}

const TIME_ICON = ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M12 7v5l3 2'];
const insertTime = (o: Outliner, h: Focus) => o.insert(h, timeOfDay());

/**
 * What the keyboard does on a computer (keymap.ts), for a touch screen,
 * grouped so the main set fits a phone without scrolling: what is used
 * all the time is one press away (outdent, indent, task, note, undo,
 * redo); kindred actions share a button that opens their set: moving up
 * and down, inserting (a link, a mirror, the time), formatting.
 */
const ACTIONS: Action[] = [
  { label: 'Вынести', icon: ['M4 6v12', 'M20 12H9', 'M13 8l-4 4 4 4'], run: (o, h) => o.run((ctx) => cmd.outdent(ctx, h.id), h) },
  { label: 'Вложить', icon: ['M20 6v12', 'M4 12h11', 'M11 8l4 4-4 4'], run: (o, h) => o.run((ctx) => cmd.indent(ctx, h.id), h) },
  { label: 'Переместить', icon: ['M8 9l4-4 4 4', 'M12 5v14', 'M8 15l4 4 4-4'], run: () => {}, opens: 'move' },
  { label: 'Задача: сделать, отметить, убрать', icon: ['M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z', 'M8.5 12.5l2.5 2.5 4.5-5'], run: (o, h) => o.cycleTask([h.id], h) },
  {
    label: 'Заметка',
    icon: ['M5 7h14', 'M5 12h14', 'M5 17h8'],
    run: (o, h) => {
      const n = o.contentOf(h.id);
      o.setFocus(h.note ? { id: h.id, caret: n.text.length } : { id: h.id, caret: n.note.length, note: true });
    },
    // In the zoom title: to its note (made if there is none) and back.
    title: (o, h) => {
      const n = o.doc.get(h.id);
      o.editTitle(h.note ? { note: false, caret: n.text.length } : { note: true, caret: n.note.length });
    },
  },
  { label: 'Вставить', icon: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M12 8v8', 'M8 12h8'], run: () => {}, opens: 'insert' },
  { label: 'Оформление', icon: ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'], run: () => {}, opens: 'format', title: true },
  // The zoom title has no set of insertions (no suggestions there): the time is its own button.
  { label: 'Вставить время', icon: TIME_ICON, run: insertTime, title: true },
  { label: 'Отменить', icon: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'], run: (o) => o.undo(), title: true },
  { label: 'Повторить', icon: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'], run: (o) => o.redo(), title: true },
];

/** The main set for a row: the time lives in the insert set there. */
const ROW_ACTIONS = ACTIONS.filter((a) => a.label !== 'Вставить время');
const TITLE_ACTIONS = ACTIONS.filter((a) => a.title);

const SETS: SubSet[] = [
  {
    name: 'move',
    label: 'Перемещение',
    stays: true,
    items: [
      { label: 'Вверх', icon: ['M12 19V5', 'M6 11l6-6 6 6'], run: (o, h) => o.run((ctx) => cmd.moveUp(ctx, h.id), h) },
      { label: 'Вниз', icon: ['M12 5v14', 'M6 13l6 6 6-6'], run: (o, h) => o.run((ctx) => cmd.moveDown(ctx, h.id), h) },
    ],
  },
  {
    name: 'insert',
    label: 'Вставка',
    items: [
      // The caret goes between the brackets, and the suggestions (Suggest.tsx) offer bullets by title.
      { label: 'Ссылка', glyph: '[[ ]]', run: (o, h) => o.insert(h, '[[]]', 0, 2) },
      { label: 'Зеркало', glyph: '(( ))', run: (o, h) => o.insert(h, '(())', 0, 2), off: (h) => !!h.note },
      { label: 'Время', icon: TIME_ICON, run: insertTime },
    ],
  },
  {
    name: 'format',
    label: 'Оформление',
    items: [
      { label: 'Жирный', icon: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'], class: 'md-bold', run: (o, h, el) => el && formatSelection(o, h.id, el, !!h.note, '**') },
      { label: 'Курсив', icon: ['M10 5h8', 'M6 19h8', 'M15 5l-6 14'], class: 'md-italic', run: (o, h, el) => el && formatSelection(o, h.id, el, !!h.note, '*') },
    ],
  },
];

/**
 * A bar of editing actions at the bottom of a touch screen while a bullet is
 * edited and the on-screen keyboard is up: the keyboard has no Tab,
 * Ctrl+L or Ctrl+Z. Hidden with the keyboard, even if the row is still
 * being edited. It sits in the page's flow, so it rests right on the keyboard
 * (index.html). Its buttons never take focus: the keyboard stays open.
 *
 * Several sets share its place (ACTIONS, SETS). A button with a set behind
 * it slides the main set out to the left and its set in from the right;
 * "Назад", or a pick in a set that does not stay, slides back. Another
 * bullet always starts on the main set. A set too wide for the screen (a
 * small phone, a wide system monospace) scrolls sideways.
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

  const [shown, setShown] = createSignal<SetName>('main');
  // Another bullet (or the other part of the title) starts on the main set; a
  // command that keeps the caret in the same row does not (the focus signal
  // fires on every request, so the row is compared by value).
  const editing = createMemo(() => o.focus()?.id ?? o.titleEdit()?.note);
  createEffect(on(editing, () => setShown('main')));

  const press = (action: Action) => {
    if (action.opens) return setShown(action.opens);
    const h = here();
    if (!h) return;
    if (inTitle()) return typeof action.title === 'function' ? action.title(o, h) : action.run(o, h);
    action.run(o, h);
  };

  const pick = (set: SubSet, item: Item) => {
    const h = here();
    const el = document.activeElement as HTMLElement | null;
    if (h && !item.off?.(h)) item.run(o, h, el?.isContentEditable ? el : null);
    if (!set.stays) setShown('main');
  };

  /** In a note a mirror is just brackets: its button is greyed out there. */
  const inNote = () => {
    const f = o.focus();
    return f ? 'note' in f && !!f.note : !!o.titleEdit()?.note;
  };

  const actions = () => (inTitle() ? TITLE_ACTIONS : ROW_ACTIONS);

  const button = (label: string, icon: string[], onClick: () => void, cls?: string) => (
    <button type="button" tabIndex={-1} class={cls} title={label} aria-label={label} onClick={onClick}>
      <Icon paths={icon} />
    </button>
  );

  /**
   * A set wider than the screen scrolls (index.css): it opens at its start,
   * and while more of it lies to the right, that edge fades.
   */
  const scrolling = (el: HTMLElement, name: SetName) => {
    const more = () => el.classList.toggle('more', el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    el.addEventListener('scroll', more, { passive: true });
    const observer = new ResizeObserver(more);
    observer.observe(el);
    createEffect(on(shown, (s) => {
      if (s !== name) return;
      el.scrollLeft = 0;
      more();
    }));
    onCleanup(() => observer.disconnect());
  };

  return (
    <Show when={touch() && keyboard() && !o.readOnly && (o.focus() || inTitle())}>
      <div class="editbar" role="toolbar" aria-label="Правка пункта" onMouseDown={(e) => e.preventDefault()}>
        <div ref={(el) => scrolling(el, 'main')} class="editbar-set editbar-main" inert={shown() !== 'main'}>
          <For each={actions()}>{(a) => button(a.label, a.icon, () => press(a))}</For>
        </div>
        <For each={SETS}>
          {(set) => (
            <div
              ref={(el) => scrolling(el, set.name)}
              class={`editbar-set editbar-sub editbar-${set.name}`}
              role="group"
              aria-label={set.label}
              inert={shown() !== set.name}
            >
              {button('Назад', ['M15 6l-6 6 6 6'], () => setShown('main'), 'editbar-back')}
              <For each={set.items}>
                {(item) => (
                  <button
                    type="button"
                    tabIndex={-1}
                    class="editbar-labelled"
                    aria-label={item.label}
                    disabled={!!item.off?.({ id: '', caret: 0, ...(inNote() ? { note: true } : {}) })}
                    onClick={() => pick(set, item)}
                  >
                    {item.glyph ? <span class="editbar-glyph" aria-hidden="true">{item.glyph}</span> : <Icon paths={item.icon!} />}
                    <span class={item.class}>{item.label}</span>
                  </button>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
