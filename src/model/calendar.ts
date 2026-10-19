import { clock } from './clock';
import { appendTrees, type Ctx } from './commands';
import { newId, type Doc } from './doc';
import { compareOrder } from './links';
import type { Tree } from './outline-text';
import { parseTags, type TagIndex } from './tags';
import type { Focus, NodeId } from './types';

/**
 * The forever calendar, after Forever Notes: one bullet per quarter, month
 * and day of the year, 29 February included, and no year anywhere in them.
 * Each day holds a bullet per year, this year's on top, so a day shows what
 * was written on it every year before.
 *
 * Bullets are named by tags alone: `@календарь`, `@q4`, `@m10`, a day
 * `@d19 @m10` (both: a search checks each bullet's own tags, so `@d19`
 * alone would not tell 19 October from 19 March), a year `@y2026`. Numbers
 * have two digits, as a tag in the search box matches by its start (`@m1`
 * would find `@m10`). The app finds a period by its tags, never by the
 * place or the order of its bullet: they may be moved, and given notes.
 */

export const CALENDAR_TAG = '@календарь';

/** Days in each month of a leap year: the calendar keeps 29 February for good. */
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const two = (n: number) => String(n).padStart(2, '0');

export type Period =
  | { kind: 'quarter'; q: number }
  | { kind: 'month'; m: number }
  | { kind: 'day'; m: number; d: number };

/** How the period's bullet is written. */
export function periodText(p: Period): string {
  switch (p.kind) {
    case 'quarter':
      return `@q${p.q}`;
    case 'month':
      return `@m${two(p.m)}`;
    case 'day':
      return `@d${two(p.d)} @m${two(p.m)}`;
  }
}

export const yearText = (year: number) => `@y${year}`;

/** The day of a date, on the device's clock. */
export const dayOf = (date: Date): Period => ({ kind: 'day', m: date.getMonth() + 1, d: date.getDate() });

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The whole calendar, for the menu to put into the document: 1 + 4 + 12 + 366 bullets. */
export function calendarTree(): Tree {
  const quarters: Tree[] = [];
  for (let q = 1; q <= 4; q++) {
    const months: Tree[] = [];
    for (let m = q * 3 - 2; m <= q * 3; m++) {
      const days: Tree[] = [];
      for (let d = 1; d <= DAYS[m - 1]; d++) days.push({ text: periodText({ kind: 'day', m, d }), children: [] });
      months.push({ text: periodText({ kind: 'month', m }), children: days });
    }
    quarters.push({ text: periodText({ kind: 'quarter', q }), children: months });
  }
  return { text: CALENDAR_TAG, children: quarters };
}

/**
 * The period a bullet's text names, by its own tags: a day has `@dNN` and
 * `@mNN`, a month only `@mNN`, a quarter `@qN`. Null for anything else (and
 * for dates no year has).
 */
export function periodOf(text: string): Period | null {
  const tags = parseTags(text);
  const num = (re: RegExp) => {
    for (const t of tags) {
      const m = re.exec(t);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const m = num(/^@m(\d\d)$/);
  const d = num(/^@d(\d\d)$/);
  if (m !== null && m >= 1 && m <= 12) {
    if (d === null) return { kind: 'month', m };
    return d >= 1 && d <= DAYS[m - 1] ? { kind: 'day', m, d } : null;
  }
  const q = num(/^@q(\d)$/);
  return q !== null && q >= 1 && q <= 4 && d === null ? { kind: 'quarter', q } : null;
}

function depthOf(doc: Doc, id: NodeId): number {
  let depth = 0;
  for (let n = doc.get(id); n.parent !== null; n = doc.get(n.parent)) depth++;
  return depth;
}

/** The highest of the bullets, the first in the outline among equals: the one a period means. */
function topmost(doc: Doc, ids: Iterable<NodeId>): NodeId | null {
  let best: NodeId | null = null;
  let bestDepth = Infinity;
  for (const id of ids) {
    const depth = depthOf(doc, id);
    if (depth < bestDepth || (depth === bestDepth && compareOrder(doc, id, best!) < 0)) {
      best = id;
      bestDepth = depth;
    }
  }
  return best;
}

/** The calendar's bullet: the highest one tagged `@календарь`; null if there is none. */
export function findCalendar(doc: Doc, tags: TagIndex): NodeId | null {
  return topmost(doc, tags.nodesWith(CALENDAR_TAG));
}

const RANK = { quarter: 0, month: 1, day: 2 };

/**
 * Whether the bullet `id` can stand for a period of this kind: it lies in
 * the calendar, and not inside a period as fine or finer (an entry
 * `созвон @d24 @m10` written in another day is not 24 October).
 */
function inPlace(doc: Doc, id: NodeId, kind: Period['kind'], calendar: NodeId): boolean {
  for (let p = doc.get(id).parent; p !== null; p = doc.get(p).parent) {
    if (p === calendar) return true;
    const outer = periodOf(doc.get(p).text);
    if (outer && RANK[outer.kind] >= RANK[kind]) return false;
  }
  return false;
}

/**
 * The bullet of a period in the calendar: the highest one inside it whose
 * own text names that period. A bullet that mentions the day lower down
 * (an entry `созвон @d19 @m10`) is not it.
 */
export function findPeriod(doc: Doc, tags: TagIndex, calendar: NodeId, p: Period): NodeId | null {
  const text = periodText(p);
  const sets = parseTags(text).map((t) => tags.nodesWith(t)).sort((a, b) => a.size - b.size);
  const found: NodeId[] = [];
  for (const id of sets[0]) {
    if (!sets.every((s) => s.has(id))) continue;
    const own = periodOf(doc.get(id).text);
    if (own && periodText(own) === text && inPlace(doc, id, p.kind, calendar)) found.push(id);
  }
  return topmost(doc, found);
}

/** The period the bullet `id` stands for in the calendar; null for any other bullet. */
export function periodAt(doc: Doc, calendar: NodeId, id: NodeId): Period | null {
  const p = periodOf(doc.get(id).text);
  return p && inPlace(doc, id, p.kind, calendar) ? p : null;
}

/**
 * The period before (`step` -1) or after (+1): days run over months and
 * from 31 December to 1 January; 29 February is skipped in a year that has
 * none.
 */
export function neighbour(p: Period, step: -1 | 1, year: number): Period {
  const wrap = (n: number, size: number) => ((n - 1 + step + size) % size) + 1;
  if (p.kind === 'quarter') return { kind: 'quarter', q: wrap(p.q, 4) };
  if (p.kind === 'month') return { kind: 'month', m: wrap(p.m, 12) };
  let { m, d } = p;
  do {
    d += step;
    if (d > DAYS[m - 1]) {
      m = wrap(m, 12);
      d = 1;
    } else if (d < 1) {
      m = wrap(m, 12);
      d = DAYS[m - 1];
    }
  } while (m === 2 && d === 29 && !isLeap(year));
  return { kind: 'day', m, d };
}

/** The day's bullet for the year: its first child tagged `@y2026`; null if there is none yet. */
export function findYear(doc: Doc, day: NodeId, year: number): NodeId | null {
  const tag = yearText(year);
  return doc.get(day).children.find((c) => parseTags(doc.get(c).text).includes(tag)) ?? null;
}

function insertBullet(doc: Doc, parent: NodeId, index: number, text: string): NodeId {
  const id = newId();
  const now = clock.now();
  doc.apply({
    t: 'insert',
    parent,
    node: {
      id, order: doc.orderAt(parent, index), text, note: '', collapsed: false, todo: false, done: false,
      created: now, updated: now, children: [],
    },
  });
  return id;
}

/**
 * Ready to write in the day: the year's bullet unfolded, made first if the
 * day has none, the caret at the end of its last entry, or in a new empty
 * one when it has none.
 */
export function openYear({ doc }: Ctx, day: NodeId, year: number): Focus {
  let y = findYear(doc, day, year);
  if (y === null) y = insertBullet(doc, day, 0, yearText(year));
  else if (doc.get(y).collapsed) doc.apply({ t: 'setCollapsed', id: y, from: true, to: false });
  const kids = doc.get(y).children;
  if (!kids.length) return { id: insertBullet(doc, y, 0, ''), caret: 0 };
  const last = kids[kids.length - 1];
  return { id: last, caret: doc.content(last).text.length };
}

/**
 * "Создать календарь": the calendar goes in as the last top-level bullet
 * (one insert, the whole tree), its quarters folded. Returns its bullet.
 */
export function createCalendar(ctx: Ctx): NodeId {
  const { doc } = ctx;
  appendTrees(ctx, doc.root, [calendarTree()]);
  const kids = doc.get(doc.root).children;
  const calendar = kids[kids.length - 1];
  for (const q of doc.get(calendar).children) doc.apply({ t: 'setCollapsed', id: q, from: false, to: true });
  return calendar;
}
