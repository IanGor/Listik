import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { prependChild } from '../model/commands';
import { plainText } from '../model/format';
import { decorate } from '../model/search';
import type { NodeId } from '../model/types';
import { caretOnLastLine, offsetFromPoint, selectionIn, setCaret } from './caret';
import { onGlobalKeys } from './keymap';
import type { Outliner } from './outliner';
import { Pieces } from './Row';

/**
 * The path from the root to where you are, the place itself included:
 * "Главная" alone on the home page. It stays above the list while the
 * zoomed-in bullet's title (ZoomTitle) scrolls away with it, as in Workflowy.
 * One line that never shortens a crumb: a long path scrolls sideways and
 * stays at its end, so the bullets next to where you are show whole.
 */
export function Crumbs(props: { o: Outliner; scrolled: boolean }) {
  const o = props.o;
  let nav!: HTMLElement;
  /** From the root's first child down to the zoomed-in bullet. */
  const path = createMemo(() => {
    o.rowsVersion();
    const id = o.zoom();
    const out: NodeId[] = [];
    if (!id || !o.doc.has(id)) return out;
    for (let p: NodeId | null = id; p !== null && p !== o.doc.root; p = o.doc.get(p).parent) out.unshift(p);
    return out;
  });

  /** Shows the end of the path; a faded left edge says there is more of it. */
  const toEnd = () => {
    nav.scrollLeft = nav.scrollWidth;
    clip();
  };
  const clip = () => nav.classList.toggle('clipped', nav.scrollLeft > 1);
  // Kept at the end when the path changes, a crumb is renamed or the bar is resized.
  createEffect(on(() => path().map((id) => {
    o.nodes.track(id);
    return o.doc.nodes.get(id)?.text;
  }).join('\n'), toEnd));
  onMount(() => {
    const observer = new ResizeObserver(toEnd);
    observer.observe(nav);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="crumbbar" classList={{ scrolled: props.scrolled }}>
      <nav ref={nav} class="crumbs" aria-label="Путь" onScroll={clip}>
        <Show
          when={path().length}
          fallback={<span class="crumb current" aria-current="page">Главная</span>}
        >
          <button type="button" class="crumb" onClick={() => o.zoomTo(null)}>Главная</button>
        </Show>
        <For each={path()}>
          {(p, i) => (
            <>
              <svg class="sep" width="8" height="10" viewBox="0 0 8 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 1.5 6 5l-3.5 3.5" />
              </svg>
              <Crumb o={o} id={p} current={i() === path().length - 1} />
            </>
          )}
        </For>
      </nav>
    </div>
  );
}

function Crumb(props: { o: Outliner; id: NodeId; current: boolean }) {
  const o = props.o;
  const id = props.id;
  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));
  const text = () => {
    o.nodes.track(id);
    return plainText(o.doc.nodes.get(id)?.text ?? '') || '…';
  };
  return (
    <Show
      when={!props.current}
      fallback={<span class="crumb current" aria-current="page" title={text()}>{text()}</span>}
    >
      <button type="button" class="crumb" title={text()} onClick={() => o.zoomTo(id)}>
        {text()}
      </button>
    </Show>
  );
}

/**
 * The zoomed-in bullet's text. It shows like a row's: tags filter on a
 * click, links lead to their bullet, bold and italic are styled. A click
 * elsewhere in it (or Ctrl+↑ from the first row, `titleRequests`) makes it
 * editable where the click was (TitleEditable).
 */
export function ZoomTitle(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));
  const text = () => {
    o.nodes.track(id);
    return o.doc.nodes.get(id)?.text ?? '';
  };
  /** Where the caret goes in the editor; null while the title only shows. */
  const [caret, setCaretAt] = createSignal<number | null>(null);
  const pieces = createMemo(() => decorate(text(), o.filter()?.query.terms ?? []));

  createEffect(on(o.titleRequests, () => !o.readOnly && setCaretAt(text().length), { defer: true }));

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const tag = target.dataset.tag;
    if (tag) return o.filterByTag(tag);
    const link = target.closest<HTMLElement>('[data-link]')?.dataset.link;
    if (link !== undefined) return o.followLink(link);
    if (o.readOnly) return;
    setCaretAt(offsetFromPoint(e.currentTarget as HTMLElement, e.clientX, e.clientY) ?? text().length);
  };

  return (
    <Show
      when={caret() !== null}
      fallback={
        <div class="zoom-title" onMouseDown={onMouseDown}>
          <Pieces o={o} pieces={pieces()} />
        </div>
      }
    >
      <TitleEditable o={o} id={id} text={text} caret={caret()!} done={() => setCaretAt(null)} />
    </Show>
  );
}

/**
 * The title being edited. Like a row's editor, the DOM is the source of
 * truth while typing; outside changes (undo) are written back. Enter starts
 * the first child; leaving it shows the title again.
 */
function TitleEditable(props: { o: Outliner; id: NodeId; text: () => string; caret: number; done: () => void }) {
  const o = props.o;
  const id = props.id;
  const text = props.text;
  let el!: HTMLDivElement;

  onMount(() => {
    el.textContent = text();
    el.focus({ preventScroll: true });
    setCaret(el, Math.min(props.caret, text().length));
  });

  createEffect(on(text, (t) => {
    if (el.textContent === t) return;
    const caret = selectionIn(el)?.[0];
    el.textContent = t;
    if (caret !== undefined) setCaret(el, Math.min(caret, t.length));
  }, { defer: true }));

  createEffect(on(o.titleRequests, () => {
    el.focus();
    setCaret(el, el.textContent?.length ?? 0);
  }, { defer: true }));

  const onInput = () => {
    const t = el.textContent ?? '';
    if (el.childNodes.length > 1 || el.firstElementChild || t.includes('\n')) {
      const caret = selectionIn(el)?.[0] ?? t.length;
      el.textContent = t.replace(/\n/g, ' ');
      setCaret(el, caret);
    }
    o.type(id, el.textContent ?? '');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.shiftKey) o.run((ctx) => prependChild(ctx, id));
    } else if (e.key === 'ArrowDown' && !e.altKey && !e.shiftKey) {
      const first = o.rows.ids[0];
      if (first && caretOnLastLine(el)) {
        e.preventDefault();
        o.setFocus({ id: first, caret: 0 });
      }
    } else if (e.key === 'ArrowLeft' && e.altKey && !e.shiftKey) {
      e.preventDefault();
      o.zoomOut();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      el.blur();
    } else {
      onGlobalKeys(e, o);
    }
  };

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
      class="zoom-title"
      contentEditable="plaintext-only"
      onFocus={() => o.setFocus(null)}
      onBlur={() => props.done()}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onBeforeInput={onBeforeInput}
    />
  );
}
