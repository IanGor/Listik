import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { matchCommands, matchTags, suggestLimit, tokenBefore, type Token } from '../model/complete';
import { tagKey, type Sigil } from '../model/tags';
import { timeOfDay } from '../model/time';
import type { NodeId } from '../model/types';
import { selectionIn } from './caret';
import type { Outliner } from './outliner';
import { touch } from './screen';

interface Item {
  label: string;
  hint?: string;
  tag?: boolean;
  /** What replaces the typed token. */
  text: () => string;
}

interface Open {
  id: NodeId;
  note: boolean;
  token: Token;
  items: Item[];
  active: number;
  /** The caret on screen, where the list hangs from. */
  x: number;
  top: number;
  bottom: number;
}

/** What each command puts in place of itself (model/complete.ts lists them). */
const RUN: Record<string, () => string> = { time: timeOfDay };

const [open, setOpen] = createSignal<Open | null>(null);
/** The token Esc closed: it stays closed until another one is typed. */
let dismissed = '';
let accept: (i: number) => void = () => {};
let refresh = () => {};

const rowHeight = () => (touch() ? 40 : 32);
const keyOf = (id: NodeId, note: boolean, t: Token) => `${id}\n${note}\n${t.start}`;

/**
 * Keys of the editing row while suggestions show (Row.tsx calls this first):
 * ↑/↓ choose, Enter or Tab take, Esc closes. Returns whether it took the key.
 */
export function suggestKey(e: KeyboardEvent): boolean {
  // `selectionchange` comes as a task of its own: a key pressed right after
  // typing would see the list as it was a character ago.
  refresh();
  const s = open();
  if (!s || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const move = (d: number) => setOpen({ ...s, active: (s.active + d + s.items.length) % s.items.length });
  switch (e.key) {
    case 'ArrowDown':
      move(1);
      break;
    case 'ArrowUp':
      move(-1);
      break;
    case 'Enter':
    case 'Tab':
      if (e.shiftKey) return false;
      accept(s.active);
      break;
    case 'Escape':
      dismissed = keyOf(s.id, s.note, s.token);
      setOpen(null);
      break;
    default:
      return false;
  }
  e.preventDefault();
  return true;
}

/** Where the caret is on screen; the element's box if the range has none. */
function caretRect(el: HTMLElement): DOMRect {
  const sel = getSelection();
  if (sel?.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.height) return r;
  }
  return el.getBoundingClientRect();
}

/**
 * Suggestions while a `/command`, `#tag` or `@tag` is typed, in a bullet or
 * its note: commands that start with what is typed, or existing tags of the
 * same sigil (model/complete.ts).
 * As many as fit about a third of the window, so fewer on a phone with its
 * keyboard up. Taking one replaces the whole word: it need not be typed out.
 * Follows the caret through `selectionchange`, which also fires on typing.
 */
export function Suggest(props: { o: Outliner }) {
  const o = props.o;

  const commands = (t: Token, limit: number): Item[] =>
    matchCommands(t.query).slice(0, limit).map((c) => ({ label: `/${c.name}`, hint: c.hint, text: RUN[c.name] }));

  /** Tags of the token's own set (`#` or `@`), by name. */
  const tags = (id: NodeId, t: Token, text: string, limit: number): Item[] => {
    const sigil = t.kind as Sigil;
    // The word being typed is already indexed as a tag, from this very
    // bullet: it counts only for the other bullets that carry it.
    const typed = tagKey(sigil, text.slice(t.start + 1, t.end));
    const self = o.tags.nodesWith(typed).has(id) ? typed : null;
    const counts = new Map<string, number>();
    for (const [key, n] of o.tags.entries()) {
      if (key.startsWith('@') !== (sigil === '@')) continue;
      counts.set(sigil === '@' ? key.slice(1) : key, key === self ? n - 1 : n);
    }
    return matchTags(counts, t.query, limit).map((name) => ({
      label: sigil + name,
      hint: String(counts.get(name)),
      tag: true,
      text: () => sigil + name,
    }));
  };

  refresh = () => {
    const el = document.activeElement as HTMLElement | null;
    const f = o.focus();
    if (!f || o.readOnly || !el?.isContentEditable || !el.closest('.row')) return setOpen(null);
    const sel = selectionIn(el);
    const text = el.textContent ?? '';
    const token = sel && sel[0] === sel[1] ? tokenBefore(text, sel[0]) : null;
    if (!token) {
      dismissed = '';
      return setOpen(null);
    }
    const note = el.classList.contains('note');
    if (keyOf(f.id, note, token) === dismissed) return setOpen(null);
    const limit = suggestLimit(innerHeight, rowHeight());
    const items = token.kind === '/' ? commands(token, limit) : tags(f.id, token, text, limit);
    if (!items.length) return setOpen(null);
    const prev = open();
    const same = prev?.id === f.id && prev.note === note && prev.token.start === token.start && prev.token.query === token.query;
    const r = caretRect(el);
    setOpen({ id: f.id, note, token, items, active: same ? Math.min(prev.active, items.length - 1) : 0, x: r.left, top: r.top, bottom: r.bottom });
  };

  accept = (i) => {
    const s = open();
    const item = s?.items[i];
    if (!s || !item) return;
    const n = o.doc.get(s.id);
    const text = s.note ? n.note : n.text;
    // A tag is followed by a space, so typing goes on after it.
    const insert = item.text() + (item.tag && !/\s/.test(text[s.token.end] ?? '') ? ' ' : '');
    setOpen(null);
    o.insert(s.note ? { id: s.id, caret: s.token.end, note: true } : { id: s.id, caret: s.token.end }, insert, s.token.end - s.token.start);
  };

  onMount(() => {
    document.addEventListener('selectionchange', refresh);
    addEventListener('resize', refresh);
    // The list hangs from the caret: it follows when the outline scrolls.
    document.addEventListener('scroll', refresh, true);
    onCleanup(() => {
      document.removeEventListener('selectionchange', refresh);
      removeEventListener('resize', refresh);
      document.removeEventListener('scroll', refresh, true);
      accept = () => {};
      refresh = () => {};
      setOpen(null);
    });
  });

  createEffect(() => {
    if (!o.focus()) setOpen(null);
  });

  /** Under the caret, or above it when the room below (down to the editing bar) is short. */
  const place = (s: Open) => {
    const width = Math.min(280, innerWidth - 16);
    const left = Math.max(8, Math.min(s.x - 12, innerWidth - width - 8));
    const floor = document.querySelector('.editbar')?.getBoundingClientRect().top ?? innerHeight;
    const height = s.items.length * rowHeight() + 10;
    return floor - s.bottom - 4 >= height
      ? { left: `${left}px`, width: `${width}px`, top: `${s.bottom + 4}px` }
      : { left: `${left}px`, width: `${width}px`, bottom: `${innerHeight - s.top + 4}px` };
  };

  return (
    <Show when={open()}>
      {(s) => (
        <div
          class="suggest"
          role="listbox"
          aria-label={s().token.kind === '/' ? 'Команды' : 'Теги'}
          style={place(s())}
          // Taking a suggestion must not take focus from the row: the keyboard stays.
          onMouseDown={(e) => e.preventDefault()}
        >
          <For each={s().items}>
            {(item, i) => (
              <div
                role="option"
                class="suggest-item"
                classList={{ current: i() === s().active, 'suggest-tag': !!item.tag }}
                aria-selected={i() === s().active}
                onPointerMove={() => i() !== s().active && setOpen({ ...s(), active: i() })}
                onClick={() => accept(i())}
              >
                <span class="suggest-label">{item.label}</span>
                <Show when={item.hint}>
                  <span class="suggest-hint">{item.hint}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
