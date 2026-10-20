import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { matchCommands, matchTags, suggestLimit, tokenBefore, type Token } from '../model/complete';
import { findInbox } from '../model/calendar';
import { findTargets } from '../model/links';
import { asksTemplate, findTemplates, matchTemplates } from '../model/templates';
import { tagKey, type Sigil } from '../model/tags';
import { timeOfDay } from '../model/time';
import { nodeOf, type RowKey } from '../model/rows';
import type { NodeId } from '../model/types';
import { selectionIn } from './caret';
import type { Outliner } from './outliner';
import { touch } from './screen';

interface Item {
  label: string;
  hint?: string;
  tag?: boolean;
  link?: boolean;
  /** A `((mirror))`: the bullet to mirror; taking it changes the bullet, not the text. */
  mirror?: NodeId;
  /** A `((mirror))` of a bullet not there yet: its title, for the original made in the Inbox. */
  create?: string;
  /** A template (model/templates.ts): taking it puts a copy in. */
  template?: NodeId;
  /** Only says something (no templates yet): taking it does nothing. */
  info?: boolean;
  /** What replaces the typed token. */
  text: () => string;
}

interface Open {
  id: RowKey;
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
/** Follows the caret; `now` computes link suggestions on the spot rather than after the next frame. */
let refresh = (_now?: boolean) => {};

const rowHeight = () => (touch() ? 40 : 32);
const keyOf = (id: RowKey, note: boolean, t: Token) => `${id}\n${note}\n${t.start}`;

/**
 * Keys of the editing row while suggestions show (Row.tsx calls this first):
 * ↑/↓ choose, Enter or Tab take, Esc closes. Returns whether it took the key.
 */
export function suggestKey(e: KeyboardEvent): boolean {
  // `selectionchange` comes as a task of its own: a key pressed right after
  // typing would see the list as it was a character ago.
  refresh(true);
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
 * Suggestions while a `/command`, `#tag`, `@tag` or `[[link` is typed, in a
 * bullet or its note: commands that start with what is typed, existing tags
 * of the same sigil (model/complete.ts), or bullets to link to by title
 * (model/links.ts).
 * As many as fit about a third of the window, so fewer on a phone with its
 * keyboard up. Taking one replaces the whole word: it need not be typed out.
 * Follows the caret through `selectionchange`, which also fires on typing.
 */
export function Suggest(props: { o: Outliner }) {
  const o = props.o;

  /** Commands, then templates by name (not in a note: a template is bullets; not the template being typed in). */
  const commands = (id: RowKey, t: Token, limit: number, note: boolean): Item[] => {
    const items: Item[] = matchCommands(t.query).slice(0, limit).map((c) => ({ label: `/${c.name}`, hint: c.hint, text: RUN[c.name] }));
    if (note) return items;
    const self = o.contentOf(id).id;
    const templates = matchTemplates(findTemplates(o.doc, o.tags).filter((tpl) => tpl.id !== self), t.query, limit - items.length);
    for (const tpl of templates) items.push({ label: tpl.title, hint: 'шаблон', template: tpl.id, text: () => '' });
    if (!templates.length && asksTemplate(t.query) && !findTemplates(o.doc, o.tags).length) {
      items.push({ label: 'Шаблонов нет: пометьте пункт #template', info: true, text: () => '' });
    }
    return items;
  };

  /** Tags of the token's own set (`#` or `@`), by name. */
  const tags = (id: RowKey, t: Token, text: string, limit: number): Item[] => {
    const sigil = t.kind as Sigil;
    // The word being typed is already indexed as a tag, from this very
    // bullet: it counts only for the other bullets that carry it.
    const typed = tagKey(sigil, text.slice(t.start + 1, t.end));
    const self = o.tags.nodesWith(typed).has(o.contentOf(id).id) ? typed : null;
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

  /**
   * Bullets to link to, with where each one is. A pass over every bullet
   * (tens of ms on 200k): kept while the query stays the same, since the
   * list is refreshed on every caret move and scroll as well. A new query is
   * looked up after the next frame unless `now`, so the typed character
   * shows first; meanwhile null, and the list stays as it was.
   */
  let found: { key: string; items: Item[] } | null = null;
  let later = false;
  const links = (id: RowKey, t: Token, limit: number, now: boolean): Item[] | null => {
    const key = `${id}\n${limit}\n${t.kind}\n${t.query}`;
    if (found?.key !== key) {
      if (!now) {
        if (!later) {
          later = true;
          requestAnimationFrame(() => setTimeout(() => {
            later = false;
            refresh(true);
          }));
        }
        return null;
      }
      const mirror = t.kind === '((';
      const items: Item[] = findTargets(o.doc, o.text, t.query, o.contentOf(id).id, limit)
        // A bullet cannot mirror itself or the bullet it already mirrors.
        .filter((target) => !mirror || o.doc.origin(target.id) !== o.doc.origin(nodeOf(id)))
        .map((target) => ({
          label: target.title,
          hint: target.where,
          link: true,
          ...(mirror ? { mirror: target.id } : {}),
          text: () => (mirror ? `((${target.title}))` : `[[${target.title}]]`),
        }));
      // No bullet of that very title: a mirror can still be made, of a new one in the Inbox.
      const title = t.query.trim();
      if (mirror && title && findInbox(o.doc) !== null && !items.some((item) => item.label.toLowerCase() === title.toLowerCase())) {
        items.push({ label: `Создать «${title}» в Inbox`, link: true, create: title, text: () => `((${title}))` });
      }
      found = { key, items };
    }
    return found.items;
  };

  refresh = (now = false) => {
    const el = document.activeElement as HTMLElement | null;
    const f = o.focus();
    if (!f || o.readOnly || !el?.isContentEditable || !el.closest('.row')) return setOpen(null);
    const sel = selectionIn(el);
    const text = el.textContent ?? '';
    const token = sel && sel[0] === sel[1] ? tokenBefore(text, sel[0]) : null;
    if (token?.kind !== '[[' && token?.kind !== '((') found = null;
    if (!token) {
      dismissed = '';
      return setOpen(null);
    }
    const note = el.classList.contains('note');
    // A mirror is a bullet, not text: `((` in a note is just parentheses.
    if (token.kind === '((' && note) return setOpen(null);
    if (keyOf(f.id, note, token) === dismissed) return setOpen(null);
    const limit = suggestLimit(innerHeight, rowHeight());
    const items =
      token.kind === '/' ? commands(f.id, token, limit, note) : token.kind === '[[' || token.kind === '((' ? links(f.id, token, limit, now) : tags(f.id, token, text, limit);
    if (!items) return;
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
    const n = o.contentOf(s.id);
    const text = s.note ? n.note : n.text;
    // A tag is followed by a space, so typing goes on after it.
    const insert = item.text() + (item.tag && !/\s/.test(text[s.token.end] ?? '') ? ' ' : '');
    setOpen(null);
    if (item.mirror) return o.makeMirror(s.id, item.mirror, s.token.start, s.token.end);
    if (item.create) return void o.mirrorTitled(s.id, item.create, s.token.start, s.token.end);
    if (item.info) return;
    if (item.template) return o.insertTemplate(s.id, item.template, s.token.start, s.token.end);
    o.insert(s.note ? { id: s.id, caret: s.token.end, note: true } : { id: s.id, caret: s.token.end }, insert, s.token.end - s.token.start);
  };

  onMount(() => {
    const follow = () => refresh();
    document.addEventListener('selectionchange', follow);
    addEventListener('resize', follow);
    // The list hangs from the caret: it follows when the outline scrolls.
    document.addEventListener('scroll', follow, true);
    onCleanup(() => {
      document.removeEventListener('selectionchange', follow);
      removeEventListener('resize', follow);
      document.removeEventListener('scroll', follow, true);
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
          aria-label={s().token.kind === '/' ? 'Команды' : s().token.kind === '[[' ? 'Ссылки' : s().token.kind === '((' ? 'Зеркала' : 'Теги'}
          style={place(s())}
          // Taking a suggestion must not take focus from the row: the keyboard stays.
          onMouseDown={(e) => e.preventDefault()}
        >
          <For each={s().items}>
            {(item, i) => (
              <div
                role="option"
                class="suggest-item"
                classList={{ current: i() === s().active, 'suggest-tag': !!item.tag, 'suggest-link': !!item.link }}
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
