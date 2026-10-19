import { createSignal } from 'solid-js';

/**
 * Text size, a setting of this browser like the theme (theme.ts): a scale of
 * the default size (17 px, 16 px on phones) for the outline's text, notes and
 * the zoom title; the header and menus keep theirs. CSS reads `--font-scale`
 * on <html> (index.css); index.html applies a saved one before the first
 * paint, so the outline never jumps from one size to another.
 */
export const TEXT_SCALES = [0.85, 1, 1.15, 1.3, 1.5] as const;
const KEY = 'listik-text-scale';

function saved(): number {
  try {
    const scale = Number(localStorage.getItem(KEY));
    return (TEXT_SCALES as readonly number[]).includes(scale) ? scale : 1;
  } catch {
    return 1;
  }
}

const [textScale, setTextScaleSignal] = createSignal(saved());

/** The scale in effect. */
export { textScale };

export function setTextScale(scale: number): void {
  document.documentElement.style.setProperty('--font-scale', String(scale));
  try {
    if (scale === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(scale));
  } catch {
    // Storage unavailable (private mode): the size lasts for this page.
  }
  setTextScaleSignal(scale);
}

/** One step smaller or larger, within the steps. */
export function stepTextScale(step: -1 | 1): void {
  const i = (TEXT_SCALES as readonly number[]).indexOf(textScale());
  const next = TEXT_SCALES[Math.max(0, Math.min(TEXT_SCALES.length - 1, i + step))];
  if (next !== textScale()) setTextScale(next);
}
