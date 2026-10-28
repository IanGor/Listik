import { createSignal } from 'solid-js';

/**
 * The outline's font, a setting of this browser like the text size
 * (textsize.ts): one of the system's own, three of each kind at most —
 * monospace, sans, serif — the ones most common on this platform and, among
 * them, first the system's own (what the browser maps `monospace`, `system-ui`
 * and `ui-serif` to: on Linux whatever fontconfig says, on Apple SF Mono, SF
 * Pro and New York). A web page cannot ask the system which fonts it has, so
 * each candidate is probed by measuring text (`installed`). CSS reads
 * `--font-text` on <html> (index.css); index.html applies a saved stack before
 * the first paint. No web fonts are loaded.
 */
export type Kind = 'mono' | 'sans' | 'serif';
export type Platform = 'apple' | 'windows' | 'android' | 'linux';

export interface FontChoice {
  kind: Kind;
  /** Shown in the list. */
  name: string;
  /** The value of `--font-text`, also what is saved. */
  stack: string;
}

interface Candidate {
  name: string;
  /** The family to probe; none for the system's own, always there. */
  family?: string;
  /** The stack to set, if not the family followed by the kind's generic one. */
  stack?: string;
}

export const KINDS: readonly Kind[] = ['mono', 'sans', 'serif'];
export const KIND_TITLES: Record<Kind, string> = { mono: 'Моноширинные', sans: 'Без засечек', serif: 'С засечками' };
const GENERIC: Record<Kind, string> = { mono: 'monospace', sans: 'sans-serif', serif: 'serif' };
/** At most this many of each kind. */
export const PER_KIND = 3;

/** The default: the system's monospace, as before this setting. */
export const DEFAULT_STACK = 'ui-monospace, monospace';

/** What the system gives by default, by the kind; named for the platform it is on. */
const system = (name: string, kind: Kind): Candidate => ({
  name,
  stack: { mono: DEFAULT_STACK, sans: 'system-ui, sans-serif', serif: 'ui-serif, serif' }[kind],
});

const named = (name: string, family = name): Candidate => ({ name, family });

/**
 * The candidates in order of how common they are on the platform and how
 * the platform's guidelines see them: Apple's SF Mono, SF Pro and New York;
 * Windows' Cascadia, Consolas and Segoe UI; Android's Roboto and Noto; Linux's
 * DejaVu, Liberation, Noto and Ubuntu families.
 */
export const CANDIDATES: Record<Platform, Record<Kind, Candidate[]>> = {
  apple: {
    mono: [system('SF Mono', 'mono'), named('Menlo'), named('Monaco'), named('Courier New')],
    sans: [system('SF Pro', 'sans'), named('Helvetica Neue'), named('Avenir Next'), named('Arial')],
    serif: [system('New York', 'serif'), named('Georgia'), named('Palatino'), named('Times New Roman')],
  },
  windows: {
    mono: [system('Системный моноширинный', 'mono'), named('Cascadia Mono'), named('Consolas'), named('Courier New')],
    sans: [system('Segoe UI', 'sans'), named('Arial'), named('Verdana'), named('Calibri')],
    serif: [system('Times New Roman', 'serif'), named('Georgia'), named('Cambria')],
  },
  android: {
    mono: [system('Системный моноширинный', 'mono'), named('Roboto Mono'), named('Droid Sans Mono'), named('Cutive Mono')],
    sans: [system('Roboto', 'sans'), named('Noto Sans'), named('Open Sans')],
    serif: [system('Noto Serif', 'serif'), named('Droid Serif'), named('Source Serif', 'Source Serif 4')],
  },
  // The system's monospace goes first and is the default: it is the one the user chose for their system.
  linux: {
    mono: [
      system('Системный моноширинный', 'mono'),
      named('DejaVu Sans Mono'),
      named('Liberation Mono'),
      named('Noto Sans Mono'),
      named('Ubuntu Mono'),
      named('JetBrains Mono'),
      named('Fira Code'),
    ],
    sans: [
      system('Системный', 'sans'),
      named('Noto Sans'),
      named('DejaVu Sans'),
      named('Liberation Sans'),
      named('Ubuntu'),
      named('Cantarell'),
      named('Roboto'),
    ],
    serif: [
      system('Системный с засечками', 'serif'),
      named('Noto Serif'),
      named('DejaVu Serif'),
      named('Liberation Serif'),
      named('Source Serif', 'Source Serif 4'),
    ],
  },
};

/** The platform by the browser's own words; an iPad asking for a desktop site calls itself a Mac, and stays one. */
export function platformOf(nav: { userAgent: string; platform?: string }): Platform {
  const ua = nav.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'apple';
  if (/Mac/i.test(nav.platform ?? '') || /Macintosh|Mac OS X/i.test(ua)) return 'apple';
  if (/Win/i.test(nav.platform ?? '') || /Windows/i.test(ua)) return 'windows';
  return 'linux';
}

const BASES = ['monospace', 'serif', 'sans-serif'];

/**
 * Is the family installed? With a font not there, the text is set in the
 * fallback and measures the same as in the fallback alone; with it there, it
 * differs from at least one of three fallbacks that differ among themselves.
 * `measure` is the width of a sample in a CSS `font` value.
 */
export function installed(family: string, measure: (font: string) => number): boolean {
  return BASES.some((base) => measure(`"${family}", ${base}`) !== measure(base));
}

/** Up to PER_KIND of each kind, in the platform's order, of those `has` says are there. */
export function pickFonts(platform: Platform, has: (family: string) => boolean): Record<Kind, FontChoice[]> {
  const out = { mono: [], sans: [], serif: [] } as Record<Kind, FontChoice[]>;
  for (const kind of KINDS) {
    for (const c of CANDIDATES[platform][kind]) {
      if (out[kind].length >= PER_KIND) break;
      if (c.family && !has(c.family)) continue;
      out[kind].push({ kind, name: c.name, stack: c.stack ?? `"${c.family}", ${GENERIC[kind]}` });
    }
  }
  return out;
}

const KEY = 'listik-font';

function saved(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_STACK;
  } catch {
    return DEFAULT_STACK;
  }
}

const [fontStack, setFontStackSignal] = createSignal(saved());

/** The stack in effect. */
export { fontStack };

export function setFont(stack: string): void {
  document.documentElement.style.setProperty('--font-text', stack);
  try {
    if (stack === DEFAULT_STACK) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, stack);
  } catch {
    // Storage unavailable (private mode): the font lasts for this page.
  }
  setFontStackSignal(stack);
}

/** The fonts this browser can offer, probed once (the first time the list is asked for). */
let offer: Record<Kind, FontChoice[]> | undefined;
export function availableFonts(): Record<Kind, FontChoice[]> {
  if (!offer) {
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (font: string) => {
      if (!ctx) return 0;
      ctx.font = `72px ${font}`;
      return ctx.measureText('mmmmmmmmmmlli0Oqwy').width;
    };
    offer = pickFonts(platformOf(navigator), (family) => installed(family, measure));
  }
  return offer;
}
