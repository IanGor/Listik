import { createEffect, on, onCleanup } from 'solid-js';
import type { Outliner } from './outliner';

/**
 * Keeps the zoom in the URL as `#/<id>`: the browser's back and forward zoom
 * out and in, and a reload stays where it was. A hash that names no bullet
 * (e.g. from another document) is dropped. Call during component setup.
 * `reload`: the place a reload comes back to shows as it was left (zooming
 * in folds it, Outliner.zoomTo).
 */
export function syncZoomWithHash(o: Outliner, reload: boolean): void {
  const fromHash = () => {
    const m = /^#\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const onHashChange = () => o.zoomTo(fromHash());
  o.zoomTo(fromHash(), false, reload);
  window.addEventListener('hashchange', onHashChange);
  onCleanup(() => window.removeEventListener('hashchange', onHashChange));

  let first = true;
  createEffect(on(o.zoom, (zoom) => {
    const hash = zoom ? `#/${encodeURIComponent(zoom)}` : '';
    const initial = first;
    first = false;
    if (location.hash === hash) return;
    const url = `${location.pathname}${location.search}${hash}`;
    // Fixing up the URL on load must not add a history entry; zooming does.
    if (initial) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }));
}
