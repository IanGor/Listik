import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import { prependChild } from '../model/commands';
import { plainText } from '../model/format';
import type { NodeId } from '../model/types';
import { caretOnLastLine, selectionIn, setCaret } from './caret';
import { onGlobalKeys } from './keymap';
import type { Outliner } from './outliner';

/**
 * The path from the root to where you are, the place itself included:
 * "Главная" alone on the home page. It stays above the list while the
 * zoomed-in bullet's title (ZoomTitle) scrolls away with it, as in Workflowy.
 * One line; a long path scrolls sideways and shows its end.
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

  createEffect(on(path, () => {
    nav.scrollLeft = nav.scrollWidth;
  }));

  return (
    <div class="crumbbar" classList={{ scrolled: props.scrolled }}>
      <nav ref={nav} class="crumbs" aria-label="Путь">
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
 * The zoomed-in bullet's text, editable in place. Like a row's editor, the
 * DOM is the source of truth while typing; outside changes (undo) are
 * written back. Enter starts the first child.
 */
export function ZoomTitle(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  let el!: HTMLDivElement;
  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));
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
      contentEditable={o.readOnly ? false : 'plaintext-only'}
      onFocus={() => o.setFocus(null)}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onBeforeInput={onBeforeInput}
    />
  );
}
