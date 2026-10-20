/**
 * Where the rows of each depth start, as index.css lays them out (`--shift`
 * on `.row`): `--indent` a level, and past `--deep` levels the narrower
 * `--indent-deep`, so that on a phone a deep branch keeps room for its text.
 * `--indent` is measured on the probe (it changes with the viewport); the
 * other two are read as written, a count and px.
 */
export interface Indentation {
  /** The start of a row at this depth, px from the start of a row at depth 0. */
  at(depth: number): number;
  /** The depth whose level holds x: the deepest one starting at or before it. */
  levelAt(x: number): number;
}

export function indentation(probe: HTMLElement): Indentation {
  const indent = probe.getBoundingClientRect().width || 20;
  const style = getComputedStyle(probe);
  const deep = parseFloat(style.getPropertyValue('--deep'));
  const narrow = parseFloat(style.getPropertyValue('--indent-deep'));
  const from = Number.isFinite(deep) && Number.isFinite(narrow) && narrow > 0 ? deep : Infinity;
  const at = (depth: number) => (depth <= from ? depth * indent : from * indent + (depth - from) * narrow);
  return {
    at,
    levelAt: (x) => (x <= from * indent ? Math.floor(x / indent) : from + Math.floor((x - from * indent) / narrow)),
  };
}
