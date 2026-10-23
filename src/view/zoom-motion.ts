import type { Doc } from '../model/doc';
import type { NodeId } from '../model/types';
import { still } from './screen';

/**
 * Going into a bullet and back out as a move the eye can follow (View
 * Transitions, where the browser has them): going in, the row's text grows
 * into the title and the list slides in from the right; going out, the
 * title shrinks back into its row in the list above (if that row shows:
 * else it fades with the list, rather than turn into another bullet's
 * text) and the list slides the other way. The header stays put, the
 * crumbs cross-fade (index.css, `html[data-zoom]`). Instant with reduced motion, without the API, or
 * between places neither inside the other (a link, "Перейти к…").
 *
 * The browser keeps the old view on screen while it captures it, so the
 * change runs a frame later, inside the transition: `change` must hold all
 * that reads the new view (the rows, the focus).
 */
export function zoomMotion(doc: Doc, from: NodeId | null, to: NodeId | null, change: () => void, row?: string): void {
  const way = from === to ? null : to !== null && (from === null || doc.within(to, from)) ? 'in' : from !== null && (to === null || doc.within(from, to)) ? 'out' : null;
  if (!way || still() || typeof document.startViewTransition !== 'function') return change();
  const html = document.documentElement;
  const before = way === 'in' ? rowText(row ?? to!) : title();
  let after: HTMLElement | null = null;
  name(before, true);
  html.dataset.zoom = way;
  const transition = document.startViewTransition(() => {
    name(before, false);
    change();
    after = way === 'in' ? title() : rowText(from!);
    name(after, true);
  });
  void transition.finished.finally(() => {
    name(after, false);
    if (html.dataset.zoom === way) delete html.dataset.zoom;
  });
}

/** The one element that morphs between the two views. */
const name = (el: HTMLElement | null, on: boolean) => {
  if (el) el.style.viewTransitionName = on ? 'zoom-title' : '';
};

const rowText = (key: string) => document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(key)}"] .text`);
const title = () => document.querySelector<HTMLElement>('.zoomhead .zoom-title');
