import { createSignal } from 'solid-js';

/**
 * A phone-width screen. The header then keeps only the logo, search and the
 * menu; the cloud and the theme switch move into the menu. The width must
 * match the `max-width: 640px` media query in index.css.
 */
const media = typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : null;

const [narrow, setNarrow] = createSignal(media?.matches ?? false);

media?.addEventListener('change', (e) => setNarrow(e.matches));

export { narrow };
