import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js';
import * as cmd from '../model/commands';
import { timeOfDay } from '../model/time';
import type { Focus } from '../model/types';
import { selectionIn } from './caret';
import { formatSelection } from './keymap';
import type { Outliner } from './outliner';
import { keyboard, touch } from './screen';

/** Which set the bar shows: the main one, or one of the sets it leads to. */
type SetName = 'main' | 'move' | 'extra';

/** `el`: the editor with the caret (the row's text or note, or the title), for what works on its selection. */
type Run = (o: Outliner, here: Focus, el: HTMLElement | null) => void;

interface Action {
  label: string;
  /** SVG paths of its icon, drawn by `Icon`… */
  icon?: string[];
  /** …or the characters it types, drawn instead. */
  glyph?: string;
  run: Run;
  /** A set this button opens instead of running (`run` is then unused). */
  opens?: Exclude<SetName, 'main'>;
}

/** A button of a set: an icon or a glyph, and its name written under it. */
interface Item {
  label: string;
  icon?: string[];
  /** Drawn instead of an icon: the brackets typed. */
  glyph?: string;
  /** Class of the written name: a format shows in its own style. */
  class?: string;
  run: Run;
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

/** A command on the bullet with the caret, one undo step; the caret stays where it was. */
type Command = Parameters<Outliner['run']>[0];
const run = (o: Outliner, h: Focus, command: (ctx: Parameters<Command>[0], id: Focus['id']) => ReturnType<Command>) =>
  o.run((ctx) => command(ctx, h.id), h);

/** Typed at the caret; a tag starts a word, so it gets a space after a letter. */
const tag: Run = (o, h, el) => {
  const before = (el?.textContent ?? '').slice(0, h.caret);
  o.insert(h, before && !/[\s(]$/.test(before) ? ' #' : '#');
};

const OUTDENT: Item = { label: 'Вынести', icon: ['M4 6v12', 'M20 12H9', 'M13 8l-4 4 4 4'], run: (o, h) => run(o, h, cmd.outdent) };
const INDENT: Item = { label: 'Вложить', icon: ['M20 6v12', 'M4 12h11', 'M11 8l4 4-4 4'], run: (o, h) => run(o, h, cmd.indent) };
const NOTE: Item = {
  label: 'Заметка',
  icon: ['M5 7h14', 'M5 12h14', 'M5 17h8'],
  run: (o, h) => {
    const n = o.contentOf(h.id);
    o.setFocus(h.note ? { id: h.id, caret: n.text.length } : { id: h.id, caret: n.note.length, note: true });
  },
};
const BOLD: Item = { label: 'Жирный', icon: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'], class: 'md-bold', run: (o, h, el) => el && formatSelection(o, h.id, el, !!h.note, '**') };
const ITALIC: Item = { label: 'Курсив', icon: ['M10 5h8', 'M6 19h8', 'M15 5l-6 14'], class: 'md-italic', run: (o, h, el) => el && formatSelection(o, h.id, el, !!h.note, '*') };
const TIME: Item = { label: 'Время', icon: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z', 'M12 7v5l3 2'], run: (o, h) => o.insert(h, timeOfDay()) };
const UNDO: Item = { label: 'Отменить', icon: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'], run: (o) => o.undo() };
const REDO: Item = { label: 'Повторить', icon: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'], run: (o) => o.redo() };

/**
 * What the keyboard does on a computer (keymap.ts), for a touch screen. The
 * main set is one row of groups, each in its own place: the bullet's place
 * in the tree (out, in, and the set that moves it), the bullet itself (task,
 * note), what is hard to type on a phone's keyboard (a #tag and a [[link]],
 * which open their suggestions), and history with the rest behind "Ещё".
 * Everything frequent is one press; the rare is two.
 */
const ROW_MAIN: Action[][] = [
  [OUTDENT, INDENT, { label: 'Переместить', icon: ['M8 9l4-4 4 4', 'M12 5v14', 'M8 15l4 4 4-4'], run: () => {}, opens: 'move' }],
  [{ label: 'Задача: сделать, отметить, убрать', icon: ['M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z', 'M8.5 12.5l2.5 2.5 4.5-5'], run: (o, h) => o.cycleTask([h.id], h) }, NOTE],
  // The caret goes after the # or between the brackets, and the suggestions (Suggest.tsx) open. A chain for the
  // link, as Apple draws one, rather than its brackets.
  [{ label: 'Тег', glyph: '#', run: tag }, { label: 'Ссылка', icon: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'], run: (o, h) => o.insert(h, '[[]]', 0, 2) }],
  [UNDO, { label: 'Ещё', icon: ['M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0z', 'M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0z', 'M20 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0z'], run: () => {}, opens: 'extra' }],
];

/**
 * In the zoom title (or its note) the bar offers what applies there, flat:
 * its note (made if there is none, and back), formatting and the time, and
 * history. No suggestions there, so no tag or link.
 */
const TITLE_MAIN: Action[][] = [
  [{
    ...NOTE,
    run: (o, h) => {
      const n = o.doc.get(h.id);
      o.editTitle(h.note ? { note: false, caret: n.text.length } : { note: true, caret: n.note.length });
    },
  }],
  [BOLD, ITALIC, TIME],
  [UNDO, REDO],
];

const SETS: SubSet[] = [
  {
    // Up and down, for a run of moves, or into a place found by name. Out and in stay
    // in the main set only: one place for each action.
    name: 'move',
    label: 'Перемещение',
    stays: true,
    items: [
      { label: 'Вверх', icon: ['M12 19V5', 'M6 11l6-6 6 6'], run: (o, h) => run(o, h, cmd.moveUp) },
      { label: 'Вниз', icon: ['M12 5v14', 'M6 13l6 6 6-6'], run: (o, h) => run(o, h, cmd.moveDown) },
      // The place line asks "Переместить в…".
      { label: 'Куда…', icon: ['M3 7h6l2 2h10v10H3z', 'M10 14h6', 'M13 11l3 3-3 3'], run: (o, h) => o.openMove([h.id]) },
    ],
  },
  {
    // The rare: one more press. Delete last, away from what is pressed often.
    name: 'extra',
    label: 'Ещё',
    items: [
      { label: 'Зеркало', glyph: '(( ))', run: (o, h) => o.insert(h, '(())', 0, 2), off: (h) => !!h.note },
      TIME,
      BOLD,
      ITALIC,
      REDO,
      { label: 'Удалить', icon: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'], run: (o, h) => run(o, h, cmd.deleteNode) },
    ],
  },
];

/**
 * A bar of editing actions at the bottom of a touch screen while a bullet is
 * edited and the on-screen keyboard is up: the keyboard has no Tab,
 * Ctrl+L or Ctrl+Z, and # and [[ hide on its symbol pages. Hidden with the keyboard, even if the row is still
 * being edited. It sits in the page's flow, so it rests right on the keyboard
 * (index.html). Its buttons never take focus: the keyboard stays open.
 *
 * Several sets share its place (ROW_MAIN, SETS). A button with a set behind
 * it slides the main set out to the left and its set in from the right;
 * "Назад", or a pick in a set that does not stay, slides back. Another
 * bullet always starts on the main set. A set too wide for the screen (a
 * small phone, a wide system monospace) scrolls sideways.
 *
 * In the zoom title (or its note) the bar is one flat set (TITLE_MAIN).
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

  /** The editor with the caret, for what works on its selection (bold, italic) or reads its text (a tag). */
  const editor = () => {
    const el = document.activeElement as HTMLElement | null;
    return el?.isContentEditable ? el : null;
  };

  const press = (action: Action) => {
    if (action.opens) return setShown(action.opens);
    const h = here();
    if (h) action.run(o, h, editor());
  };

  const pick = (set: SubSet, item: Item) => {
    const h = here();
    if (h && !item.off?.(h)) item.run(o, h, editor());
    if (!set.stays) setShown('main');
  };

  /** In a note a mirror is just brackets: its button is greyed out there. */
  const inNote = () => {
    const f = o.focus();
    return f ? 'note' in f && !!f.note : !!o.titleEdit()?.note;
  };

  const groups = () => (inTitle() ? TITLE_MAIN : ROW_MAIN);

  const button = (a: Action | Item, onClick: () => void, cls?: string) => (
    <button type="button" tabIndex={-1} class={cls} title={a.label} aria-label={a.label} onClick={onClick}>
      {a.glyph ? <span class="editbar-glyph" aria-hidden="true">{a.glyph}</span> : <Icon paths={a.icon!} />}
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
          <For each={groups()}>
            {(group, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="editbar-sep" aria-hidden="true" />
                </Show>
                <For each={group}>{(a) => button(a, () => press(a))}</For>
              </>
            )}
          </For>
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
              {button({ label: 'Назад', icon: ['M15 6l-6 6 6 6'], run: () => {} }, () => setShown('main'), 'editbar-back')}
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
                    <span class={`editbar-caption ${item.class ?? ''}`}>{item.label}</span>
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
