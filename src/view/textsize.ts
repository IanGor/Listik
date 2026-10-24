import { createSignal } from 'solid-js';

/**
 * Text size, a setting of this browser like the theme (theme.ts): a scale of
 * the default size (17 px, 16 px on phones) for the outline's text, notes and
 * the zoom title, on top of the system's text size on an iPad or iPhone
 * (`followSystemSize`); the header and menus keep theirs. CSS reads `--font-scale`
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

/** The size of body text in the system's Settings at their default ("Large"), px. */
const SYSTEM_DEFAULT = 17;

/**
 * Dynamic Type: on an iPad or iPhone the outline's text also follows the
 * text size picked in the system's Settings (Apple's guidelines), the scale
 * above coming on top. WebKit gives that size as the font `-apple-system-body`;
 * a Mac has it too, at 13 px, so only a touch screen follows it. Read again
 * when the app comes back to the front: the size may have been changed in
 * Settings meanwhile.
 */
export function followSystemSize(): void {
  if (!CSS.supports('font', '-apple-system-body') || !matchMedia('(pointer: coarse)').matches) return;
  const root = document.documentElement;
  const read = () => {
    const probe = document.createElement('span');
    probe.style.font = '-apple-system-body';
    root.append(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    if (px > 0) root.style.setProperty('--system-scale', String(px / SYSTEM_DEFAULT));
  };
  read();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') read();
  });
}
