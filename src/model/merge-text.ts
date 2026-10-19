import fastDiff from 'fast-diff';

/** A replacement of `base.slice(start, end)` with `text`. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The edits that turn `base` into `next`, as ranges of `base`. */
function edits(base: string, next: string): Edit[] {
  const out: Edit[] = [];
  let pos = 0;
  let open: Edit | null = null;
  for (const [kind, text] of fastDiff(base, next)) {
    if (kind === fastDiff.EQUAL) {
      open = null;
      pos += text.length;
      continue;
    }
    if (!open) out.push((open = { start: pos, end: pos, text: '' }));
    if (kind === fastDiff.DELETE) {
      open.end += text.length;
      pos += text.length;
    } else {
      open.text += text;
    }
  }
  return out;
}

const same = (a: Edit, b: Edit) => a.start === b.start && a.end === b.end && a.text === b.text;

/** Do the edits touch each other? Two insertions at the same point do: their order would be a guess. */
function overlap(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  return a.start < b.end && b.start < a.end;
}

/**
 * Three-way merge of a bullet's text: `base` was edited into `theirs` on
 * another device and into `ours` here. When the two sets of changes touch
 * different parts of the text, both are kept; returns null when they
 * collide, and the caller decides who wins.
 */
export function merge3(base: string, theirs: string, ours: string): string | null {
  if (theirs === ours || base === ours) return theirs;
  if (base === theirs) return ours;
  const a = edits(base, theirs);
  const b = edits(base, ours);
  const all: Edit[] = [];
  for (const x of a) {
    for (const y of b) {
      if (same(x, y)) continue;
      if (overlap(x, y)) return null;
    }
    all.push(x);
  }
  for (const y of b) if (!a.some((x) => same(x, y))) all.push(y);
  all.sort((x, y) => x.start - y.start || x.end - y.end);
  let out = base;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}
