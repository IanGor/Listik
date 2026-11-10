import { placeTrees, type Ctx } from './commands';
import type { Doc } from './doc';
import { compareOrder, titleOf } from './links';
import type { Tree } from './outline-text';
import { parseTags, type TagIndex } from './tags';
import type { NodeId } from './types';

/** Calendar → year → month → ISO week → day. Legacy root years/quarters remain readable. */

const two = (n: number) => String(n).padStart(2, '0');

/** The top level the structure puts in, in this order, and the bullets inside each. */
export const STRUCTURE: readonly { text: string; children: readonly string[] }[] = [
  { text: '📥 Inbox', children: [] },
  { text: 'PARA', children: ['Projects', 'Areas', 'Resources', 'Archive'] },
  { text: 'Kanban', children: ['Backlog'] },
];

/** `@имя` of each weekday, from Sunday (Date.getDay). */
/** A year, two digits, wherever the app writes it: `@y26`. */
const yearTag = (y: number) => `@y${two(y % 100)}`;
const SHORT_YEAR = /^@y\d\d$/;

export const WEEKDAYS = ['@воскресенье', '@понедельник', '@вторник', '@среда', '@четверг', '@пятница', '@суббота'];

/** The time slots of a day: 09:00 to 18:00 every half hour. */
export const SLOTS = Array.from({ length: 19 }, (_, i) => `${two(9 + Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);

/**
 * A period of the calendar, with its year. `quarter` is a year's bullet in
 * `@qN`: the quarter of that year.
 */
export type Period =
  | { kind: 'year'; y: number }
  | { kind: 'quarter'; y: number; q: number }
  | { kind: 'month'; y: number; m: number }
  | { kind: 'week'; y: number; m: number; w: number }
  | { kind: 'day'; y: number; m: number; d: number };

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

export const daysIn = (y: number, m: number) => utc(y, m + 1, 0).getUTCDate();

export const quarterOf = (m: number) => Math.ceil(m / 3);

/** The ISO week of a date: weeks start on Monday, week 1 holds the year's first Thursday. */
export function isoWeek(y: number, m: number, d: number): number {
  const date = utc(y, m, d);
  // The Thursday of the same week decides the week's year.
  date.setUTCDate(d + 4 - (date.getUTCDay() || 7));
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86_400_000 / 7) + 1;
}

/** The weeks of a month, in order: a week is there if any of its days is. */
export function weeksOf(y: number, m: number): number[] {
  const weeks: number[] = [];
  for (let d = 1; d <= daysIn(y, m); d++) {
    const w = isoWeek(y, m, d);
    if (weeks[weeks.length - 1] !== w) weeks.push(w);
  }
  return weeks;
}

/**
 * How the period's bullet is written. A day has its year too, a short tag
 * (`@y26`): its title is then its own (a link or "Перейти к…" by it finds
 * this day, not the same date and weekday some years before), and the year
 * filters like every other tag, while `@d19 @m10` alone still finds the day
 * in every year. The year's own bullet is the same tag alone: a day has
 * `@d` and is read as a day first (`labelOf`). Days without the year are
 * found all the same (`findPeriod`) and get it once, and years written
 * `@y2026` by earlier versions become `@y26` (`yearTags`).
 */
export function periodText(p: Period): string {
  switch (p.kind) {
    case 'year':
    case 'quarter':
      return yearTag(p.y);
    case 'month':
      return `@m${two(p.m)}`;
    case 'week':
      return `@w${two(p.w)}`;
    case 'day':
      return `@d${two(p.d)} @m${two(p.m)} ${yearTag(p.y)} ${WEEKDAYS[utc(p.y, p.m, p.d).getUTCDay()]}`;
  }
}

/** The period for people: «19.10.2026», «октябрь 2026», «неделя 43, октябрь 2026», «4 квартал 2026». */
export function periodName(p: Period): string {
  const month = (m: number) => new Date(2000, m - 1, 1).toLocaleString('ru', { month: 'long' });
  switch (p.kind) {
    case 'year':
      return String(p.y);
    case 'quarter':
      return `${p.q} квартал ${p.y}`;
    case 'month':
      return `${month(p.m)} ${p.y}`;
    case 'week':
      return `неделя ${p.w}, ${month(p.m)} ${p.y}`;
    case 'day':
      return `${two(p.d)}.${two(p.m)}.${p.y}`;
  }
}

/** The day of a date, on the device's clock. */
export const dayOf = (date: Date): Period => ({ kind: 'day', y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() });

/** A whole year; optional quarter is only for reading/building legacy fixtures. */
export function yearTree(y: number, q?: number): Tree {
  const months: Tree[] = [];
  for (let m = q === undefined ? 1 : q * 3 - 2; m <= (q === undefined ? 12 : q * 3); m++) {
    const weeks: Tree[] = [];
    for (let d = 1; d <= daysIn(y, m); d++) {
      const w = periodText({ kind: 'week', y, m, w: isoWeek(y, m, d) });
      if (weeks[weeks.length - 1]?.text !== w) weeks.push({ text: w, collapsed: true, children: [] });
      weeks[weeks.length - 1].children.push({ text: periodText({ kind: 'day', y, m, d }), collapsed: true, children: [] });
    }
    months.push({ text: periodText({ kind: 'month', y, m }), collapsed: true, children: weeks });
  }
  return { text: yearTag(y), collapsed: true, children: months };
}

/** A root container with the whole word Calendar, allowing emoji and other words. */
export function findCalendar(doc: Doc): NodeId | null {
  const id = doc.get(doc.root).children.find((id) => calendarTitle(doc.content(id).text));
  return id === undefined ? null : doc.host(id)?.id ?? null;
}

const calendarTitle = (text: string) => titleOf(text).normalize('NFKC').toLowerCase()
  .match(/[\p{L}\p{N}_]+/gu)?.includes('calendar') ?? false;

function calendarHost(doc: Doc, id: NodeId): boolean {
  if (!(doc.get(id).parent === doc.root && calendarTitle(doc.content(id).text)) && !doc.hasMirrors(id)) return false;
  return findCalendar(doc) === id;
}

function yearParent(doc: Doc, id: NodeId): boolean {
  const parent = doc.get(id).parent;
  return parent === doc.root || (parent !== null && calendarHost(doc, parent));
}

/** Auto-created containers use a shared ID so simultaneous starts converge. */
function ensureCalendar(ctx: Ctx, index = ctx.doc.get(ctx.doc.root).children.length): NodeId {
  const found = findCalendar(ctx.doc);
  if (found !== null) return found;
  return placeTrees(ctx, ctx.doc.root, index, [{ id: `${ctx.doc.root}~calendar`, text: 'Calendar', collapsed: true, children: [] }])!.id;
}

/** Preflight auto-packing, before creating a container or moving any year. */
export function calendarPackingPlan(doc: Doc): { years: NodeId[]; calendar: NodeId | null; error?: string } {
  const calendar = findCalendar(doc);
  const years = doc.get(doc.root).children.filter((id) => periodAt(doc, id)?.kind === 'year');
  const seen = new Set<number>();
  const error = (text: string) => ({ years, calendar, error: `Calendar: ${text}. Годы не перемещены.` });
  if (!years.length) return { years, calendar };
  if (calendar !== null) {
    for (const id of doc.get(calendar).children) {
      const label = labelOf(doc.content(id).text);
      if (label?.kind === 'year') seen.add(label.y);
    }
  }
  for (const id of years) {
    const p = periodAt(doc, id)!;
    if (seen.has(p.y)) return error(`год ${p.y} повторяется в корне или календаре`);
    if (calendar !== null && doc.within(calendar, id)) return error('контейнер находится внутри переносимого года');
    seen.add(p.y);
  }
  years.sort((a, b) => periodAt(doc, b)!.y - periodAt(doc, a)!.y);
  return { years, calendar };
}

/** Service migration: move existing root years, preserving all node content and state. */
export function packCalendar(ctx: Ctx): { changed: boolean; error?: string } {
  const { doc, rows } = ctx;
  const plan = calendarPackingPlan(doc);
  if (plan.error || !plan.years.length) return { changed: false, error: plan.error };
  const index = Math.min(...plan.years.map((id) => doc.index(id)));
  const calendar = plan.calendar ?? ensureCalendar(ctx, index);
  rows.expectMany();
  plan.years.forEach((id, i) => {
    const n = doc.get(id);
    doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: calendar, order: doc.orderAt(calendar, i) } });
  });
  return { changed: true };
}

function calendarYearChildren(doc: Doc): NodeId[] {
  const calendar = findCalendar(doc);
  return calendar === null ? [] : doc.get(calendar).children;
}

/**
 * Years, months and weeks of the calendar left open. They are made folded,
 * so that opening a quarter (or "Главная" opening the top level) is an
 * overview, not the ~470 rows of a whole year; those made open before
 * (`Outliner.foldCalendar`) are found here.
 */
export function openPeriods(doc: Doc): NodeId[] {
  const out: NodeId[] = [];
  const walk = (id: NodeId, rank: number) => {
    for (const c of doc.get(id).children) {
      const label = labelOf(doc.get(c).text);
      if (!label || RANK[label.kind] !== rank) continue;
      const n = doc.get(c);
      if (!n.collapsed && n.children.length) out.push(c);
      if (rank < RANK.week) walk(c, rank + 1);
    }
  };
  for (const id of [...doc.get(doc.root).children, ...calendarYearChildren(doc)]) {
    const label = labelOf(doc.get(id).text);
    if (label?.kind === 'quarter') walk(id, RANK.year);
    if (label?.kind === 'year') {
      if (!doc.get(id).collapsed && doc.get(id).children.length) out.push(id);
      walk(id, RANK.month);
    }
  }
  return out;
}

/** The whole structure, with a Calendar container and a folded year. */
export function structureTrees(y: number): Tree[] {
  return [
    ...STRUCTURE.map(({ text, children }) => ({
      text, ...(text === 'Kanban' ? { collapsed: true } : {}),
      children: children.map((c) => ({ text: c, children: [] })),
    })),
    { text: 'Calendar', collapsed: true, children: [yearTree(y)] },
  ];
}

/** The caption (note) of the Kanban's Today: its contexts, ready to filter the tasks by work or by home. */
export const TODO_NOTE = '@work @home';

/**
 * What an empty day gets when first entered: a note bullet and half-hour
 * slots as direct children. `fillDayToday` inserts the Kanban Today mirror
 * between the note and the slots. Populated days keep their existing layout.
 */
export function dayTemplate(): Tree[] {
  return [
    { text: '#daynote', children: [] },
    ...SLOTS.map((text) => ({ text, children: [] })),
  ];
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthName = (m: number) => utc(2000, m, 1).toLocaleString('ru', { month: 'long', timeZone: 'UTC' });
const weekday = (p: { y: number; m: number; d: number }, style: 'long' | 'short') => utc(p.y, p.m, p.d).toLocaleString('ru', { weekday: style, timeZone: 'UTC' });

/**
 * How a bullet of the calendar reads to people, when its text is its tags
 * only (as the app writes it): «Четверг, 29 октября 2026» for a day's
 * title, «Чт 29» in the path. The tags stay the bullet's text, for search
 * and the calendar's own finding (`periodAt`); this is how they show
 * (UX audit, 29 October 2026). Null for anything else.
 */
export function calendarName(doc: Doc, id: NodeId, use: 'title' | 'crumb'): string | null {
  const n = doc.get(id);
  if (n.text.replace(/(^|\s)[@#]\S+/g, '').trim()) return null;
  const label = labelOf(n.text);
  if (!label) return null;
  if (label.kind === 'quarter') return quarterAt(doc, id) === null ? null : use === 'crumb' ? `Q${label.q}` : `${label.q} квартал`;
  const p = periodAt(doc, id);
  if (!p) return null;
  const short = use === 'crumb';
  switch (p.kind) {
    case 'year':
    case 'quarter':
      return String(p.y);
    case 'month':
      return short ? capital(monthName(p.m)) : `${capital(monthName(p.m))} ${p.y}`;
    case 'week':
      return short ? `Неделя ${p.w}` : `Неделя ${p.w} · ${monthName(p.m)} ${p.y}`;
    case 'day':
      return short
        ? `${capital(weekday(p, 'short'))} ${p.d}`
        : `${capital(weekday(p, 'long'))}, ${utc(p.y, p.m, p.d).toLocaleString('ru', { day: 'numeric', month: 'long', timeZone: 'UTC' })} ${p.y}`;
  }
}

/** What a bullet's own tags call it, without the periods around it. */
type Label =
  | { kind: 'quarter'; q: number }
  | { kind: 'year'; y: number }
  | { kind: 'month'; m: number }
  | { kind: 'week'; w: number }
  | { kind: 'day'; m: number; d: number };

const RANK = { quarter: 0, year: 1, month: 2, week: 3, day: 4 };

/**
 * The label in a bullet's text: a day has `@dNN` and `@mNN`, a week
 * `@wNN`, a month only `@mNN`, a year `@yNN` (`@yNNNN` from earlier
 * versions, until `yearTags`), a quarter `@qN`. Null for
 * anything else (and for dates no year has).
 */
export function labelOf(text: string): Label | null {
  if (!text.includes('@')) return null;
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
  const w = num(/^@w(\d\d)$/);
  if (d !== null) return m !== null && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(2000, m) ? { kind: 'day', m, d } : null;
  if (w !== null) return w >= 1 && w <= 53 ? { kind: 'week', w } : null;
  if (m !== null) return m >= 1 && m <= 12 ? { kind: 'month', m } : null;
  const y = num(/^@y(\d\d|\d{4})$/);
  if (y !== null) return { kind: 'year', y: y < 100 ? 2000 + y : y };
  const q = num(/^@q(\d)$/);
  return q !== null && q >= 1 && q <= 4 ? { kind: 'quarter', q } : null;
}

/** A top-level bullet of the structure's quarter: its number; null for anything else. */
function quarterAt(doc: Doc, id: NodeId): number | null {
  const n = doc.get(id);
  const label = n.parent === doc.root ? labelOf(n.text) : null;
  return label?.kind === 'quarter' ? label.q : null;
}

/**
 * The period the bullet `id` stands for: its own label, with the year (and
 * for a week, the month) of the periods around it, inside Calendar or a legacy root year
 * or a legacy top-level quarter. Null for any other bullet, for one inside a period as fine or
 * finer (an entry `созвон @d24 @m10` written in another day is not 24
 * October), and for a day not right in a week (the same entry written in
 * a month).
 */
export function periodAt(doc: Doc, id: NodeId): Period | null {
  const own = labelOf(doc.get(id).text);
  if (!own || own.kind === 'quarter' || calendarHost(doc, id) ||
    (doc.get(id).parent === doc.root && calendarTitle(doc.content(id).text))) return null;
  // A day lies right in a week: `созвон @today` written in a month is an entry.
  if (own.kind === 'day' && labelOf(doc.get(doc.get(id).parent ?? doc.root).text)?.kind !== 'week') return null;
  let y: number | null = null;
  let m: number | null = null;
  let q: number | null = null;
  let rooted = own.kind === 'year' && yearParent(doc, id);
  for (let p = doc.get(id).parent; p !== null && p !== doc.root; p = doc.get(p).parent) {
    if (calendarHost(doc, p)) break;
    const outer = labelOf(doc.get(p).text);
    if (!outer) continue;
    if (RANK[outer.kind] >= RANK[own.kind]) return null;
    if (outer.kind === 'year') {
      y ??= outer.y;
      if (yearParent(doc, p)) rooted = true;
    } else if (outer.kind === 'month') m ??= outer.m;
    else q = quarterAt(doc, p);
  }
  if (q === null && !rooted) return null;
  switch (own.kind) {
    case 'year':
      return q === null ? { kind: 'year', y: own.y } : { kind: 'quarter', y: own.y, q };
    case 'month':
      return y === null ? null : { kind: 'month', y, m: own.m };
    case 'week':
      return y === null || m === null ? null : { kind: 'week', y, m, w: own.w };
    case 'day':
      return y === null ? null : { kind: 'day', y, m: own.m, d: own.d };
  }
}

const samePeriod = (a: Period, b: Period) => JSON.stringify(a) === JSON.stringify(b);

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

/** The quarter `@qN` at the top level, the first one if the structure is there twice; null if there is none. */
export function findQuarter(doc: Doc, tags: TagIndex, q: number): NodeId | null {
  return topmost(doc, [...tags.nodesWith(`@q${q}`)].filter((id) => quarterAt(doc, id) === q));
}

/**
 * The first word of a title as it reads: formatting, link brackets, emoji,
 * signs and tag marks left out, any case (`📥 **Inbox** 2026` → "inbox").
 */
export function firstWord(text: string): string {
  return titleOf(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/u)?.[0] ?? '';
}

/**
 * The structure's Inbox, where new bullets go: the first top-level bullet
 * whose first word is "Inbox", whatever emoji or formatting is around it;
 * for a copy of a mirror, the bullet that holds its children. Null if there
 * is none.
 */
export function findInbox(doc: Doc): NodeId | null {
  const id = doc.get(doc.root).children.find((c) => firstWord(doc.content(c).text) === 'inbox');
  return id === undefined ? null : doc.host(id)?.id ?? null;
}

/** A Calendar container, legacy root year or legacy root quarter. */
export const hasStructure = (doc: Doc, tags: TagIndex) =>
  findCalendar(doc) !== null || doc.get(doc.root).children.some((id) => periodAt(doc, id)?.kind === 'year') ||
  [1, 2, 3, 4].some((q) => findQuarter(doc, tags, q) !== null);

/** The bullet of a period: the highest one whose own tags and surroundings make it that period. */
export function findPeriod(doc: Doc, tags: TagIndex, p: Period): NodeId | null {
  const sets =
    (p.kind === 'quarter' || p.kind === 'year')
      ? // A year written `@y2026` is still a year until it is renamed (`yearTags`).
        [new Set([...tags.nodesWith(yearTag(p.y)), ...tags.nodesWith(`@y${p.y}`)])]
      : parseTags(periodText(p))
          .filter((t) => !WEEKDAYS.includes(t) && !SHORT_YEAR.test(t))
          .map((t) => tags.nodesWith(t))
          .sort((a, b) => a.size - b.size);
  const found: NodeId[] = [];
  for (const id of sets[0]) {
    if (!sets.every((s) => s.has(id))) continue;
    const at = periodAt(doc, id);
    if (at && samePeriod(at, p)) found.push(id);
  }
  // An entry with the day's tags in its week (`созвон @today`) is not the
  // day: one that is tags alone comes first.
  const bare = found.filter((id) => onlyTags(doc.get(id).text));
  return topmost(doc, bare.length ? bare : found);
}

/** Text that is tags and nothing else, as the app names a period. */
const onlyTags = (text: string) => text.split(/\s+/).every((w) => !w || /^@[\p{L}\p{N}_-]+$/u.test(w));

/** The quarter of the year a period lies in. */
export function quarterPeriod(p: Period): Period {
  return p.kind === 'year' ? p : { kind: 'quarter', y: p.y, q: p.kind === 'quarter' ? p.q : quarterOf(p.m) };
}

/**
 * "Создать структуру": the structure goes in as the last top-level bullets,
 * Calendar reused when present, adding a missing year first. Returns
 * its first bullet.
 */
export function createStructure(ctx: Ctx, y: number): NodeId {
  const { doc } = ctx;
  if (packCalendar(ctx).error) return doc.root;
  const trees = structureTrees(y);
  const calendarTree = trees.pop()!;
  const first = placeTrees(ctx, doc.root, doc.get(doc.root).children.length, trees)!.id;
  const calendar = findCalendar(doc);
  if (calendar === null) {
    placeTrees(ctx, doc.root, doc.get(doc.root).children.length, [calendarTree]);
  } else if (!doc.get(calendar).children.some((id) => {
    const label = labelOf(doc.content(id).text);
    return label?.kind === 'year' && label.y === y;
  })) {
    placeTrees(ctx, calendar, 0, [yearTree(y)]);
  }
  return first;
}

/** Any year already present, including the old quarter layout. */
export function hasYear(doc: Doc, tags: TagIndex, y: number): boolean {
  return findPeriod(doc, tags, { kind: 'year', y }) !== null ||
    [1, 2, 3, 4].some((q) => findPeriod(doc, tags, { kind: 'quarter', y, q }) !== null);
}

export function addYear(ctx: Ctx, tags: TagIndex, y: number): boolean {
  const { doc } = ctx;
  if (hasYear(doc, tags, y)) return false;
  const packed = packCalendar(ctx);
  if (packed.error) return false;
  const calendar = ensureCalendar(ctx);
  placeTrees(ctx, calendar, 0, fixedIds([yearTree(y)], `${doc.root}~calendar~y${y}~`));
  return true;
}

/** A day entered for the first time, with nothing in it: the template goes in. Returns whether it did. */
export function fillDay(ctx: Ctx, day: NodeId): boolean {
  if (ctx.doc.get(day).children.length) return false;
  placeTrees(ctx, day, 0, fixedIds(dayTemplate(), `${day}~`));
  return true;
}

/**
 * Ids by place under `prefix` (`Tree.id`): what the app builds by itself is
 * built alike on every device, so a year or a day's template made on two
 * devices before they heard of each other (two devices open at midnight)
 * merges into one, not two side by side. The prefix is a bullet they share
 * (the document root, the day); `.` and `~` never occur in a random id.
 */
export function fixedIds(trees: Tree[], prefix: string): Tree[] {
  return trees.map((t, i) => ({ ...t, id: `${prefix}${i}`, children: fixedIds(t.children, `${prefix}${i}.`) }));
}

/**
 * Year tags as the app writes them now, for calendars made by earlier
 * versions: the text each bullet should have. A year written `@y2026`
 * becomes `@y26`; a day without its year tag (`@d19 @m10 @понедельник`,
 * or with the year as plain text after it) gets it after the month, and a
 * plain year at the end goes. What else the bullet says stays.
 */
export function yearTags(doc: Doc): { id: NodeId; text: string }[] {
  const out: { id: NodeId; text: string }[] = [];
  const visit = (id: NodeId) => {
    const n = doc.get(id);
    const p = periodAt(doc, id);
    if (!p) return;
    let text = n.text;
    if (p.kind === 'year' || p.kind === 'quarter') {
      text = text.replace(/(^|\s)@y(\d{4})(?=\s|$)/, (_, before: string, y: string) => before + yearTag(Number(y)));
    } else if (p.kind === 'day' && !parseTags(text).some((t) => SHORT_YEAR.test(t))) {
      text = text.replace(new RegExp(` ${p.y}$`), '').replace(/(^|\s)(@m\d\d)(?=\s|$)/, `$1$2 ${yearTag(p.y)}`);
    }
    if (text !== n.text) out.push({ id: n.id, text });
    if (p.kind !== 'day') for (const child of n.children) visit(child);
  };
  for (const id of [...doc.get(doc.root).children, ...calendarYearChildren(doc)]) {
    if (quarterAt(doc, id) !== null) for (const child of doc.get(id).children) visit(child);
    else visit(id);
  }
  return out;
}

/** A date of the calendar. */
export interface DayDate {
  y: number;
  m: number;
  d: number;
}

export const sameDate = (a: DayDate, b: DayDate) => a.y === b.y && a.m === b.m && a.d === b.d;

/** The date `n` days after (before, if negative). */
export function addDays(p: DayDate, n: number): DayDate {
  const date = new Date(p.y, p.m - 1, p.d + n);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}
