import { daysIn, firstWord, periodAt } from './calendar';
import { clock } from './clock';
import { TRASH, newId, trashKey, type Doc } from './doc';
import type { Ctx } from './commands';
import { nodeOf, type RowKey } from './rows';
import { searchable } from './tags';
import type { NodeId, OutlineNode } from './types';

/**
 * Planning a bullet for a day (October 2026): its plan is a mirror of it
 * right in that day's `todo` list, nothing kept on the bullet itself.
 * Planning puts one there, folded; cancelling takes the mirrors from the
 * days to come away. So the plan syncs, undoes and stays in each day's list
 * as a record of what was in focus, and taking the mirror out of `todo` by
 * hand cancels the plan. A bullet is planned for one day at a time: a new
 * date moves it. (First it was a star into today's list only: `starsIn`,
 * `carryStars` are from then, and today is a date like any other.)
 *
 * What a starred bullet's day came to is read from the tasks inside it,
 * never from a check on the bullet itself (that would strike the project
 * through everywhere and send it last in its list): see `standing`.
 */

/** The title of a day's list of things to do (`dayTemplate`). */
export const TODO = 'todo';

/** The day's `todo`: the first bullet right in it whose first word is "todo". Null if it has none. */
export function todoOf(doc: Doc, day: NodeId): NodeId | null {
  return doc.get(day).children.find((c) => !doc.get(c).mirrorOf && firstWord(doc.get(c).text) === TODO) ?? null;
}

/** Is the bullet a day's `todo` list? */
export function isTodo(doc: Doc, id: NodeId): boolean {
  const parent = doc.get(id).parent;
  return parent !== null && parent !== TRASH && periodAt(doc, parent)?.kind === 'day' && todoOf(doc, parent) === id;
}

/** The mirrors of the bullet (of any copy of it) lying right in the list `todo`: its stars there. */
export function starsIn(doc: Doc, todo: NodeId, id: NodeId): NodeId[] {
  const origin = doc.origin(id);
  return doc.copies(origin).filter((c) => c !== origin && doc.get(c).parent === todo);
}

/**
 * Can the bullet be starred: a bullet of the outline that search sees (not
 * `#secret`, which no mirror shows), and not the calendar's own bullets
 * (a quarter, a year, …, a day), nor a day's `todo`, nor one written right
 * in today's list, which is there already.
 */
export function starrable(doc: Doc, id: NodeId, todo: NodeId | null): boolean {
  if (!doc.has(id)) return false;
  const origin = doc.origin(id);
  if (origin === doc.root || !doc.has(origin) || doc.get(origin).mirrorOf) return false;
  if (!doc.inOutline(origin) || !searchable(doc, origin)) return false;
  const n = doc.get(origin);
  if (periodAt(doc, origin) || (n.parent === doc.root && /^@q\d$/.test(n.text.trim()))) return false;
  if (isTodo(doc, origin)) return false;
  return todo === null || n.parent !== todo;
}

/** Where a new star goes in the list: last, but above the empty bullets at its end (the template's one to write in). */
function starIndex(doc: Doc, todo: NodeId): number {
  const kids = doc.get(todo).children;
  let i = kids.length;
  while (i > 0) {
    const n = doc.get(kids[i - 1]);
    if (n.mirrorOf || n.text || n.note || n.todo || n.children.length) break;
    i--;
  }
  return i;
}

/** Mirrors of `origins` into the list at `index`, folded: a project shows its next task under it (`PendingTasks`), not its whole tree. */
function putStars(doc: Doc, todo: NodeId, index: number, origins: NodeId[]): NodeId[] {
  if (!origins.length) return [];
  const orders = doc.ordersAt(todo, index, origins.length);
  const now = clock.now();
  return origins.map((origin, i) => {
    const id = newId();
    doc.apply({
      t: 'insert', parent: todo,
      node: { id, order: orders[i], text: '', note: '', collapsed: true, todo: false, done: false, created: now, updated: now, children: [], mirrorOf: origin },
    });
    return id;
  });
}

/** Takes a star away: the mirror goes to the trash out of its list (it holds nothing of its own to bring back). */
function dropStar(doc: Doc, id: NodeId): void {
  const n = doc.get(id);
  doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: TRASH, order: trashKey(clock.now()) } });
}

/** A date of the calendar. */
export interface PlanDate {
  y: number;
  m: number;
  d: number;
}

/** A plan: the mirror in the list `todo` of the day `date`. */
export interface Plan {
  star: NodeId;
  todo: NodeId;
  date: PlanDate;
}

const stamp = (p: PlanDate) => p.y * 10_000 + p.m * 100 + p.d;

export const sameDate = (a: PlanDate, b: PlanDate) => stamp(a) === stamp(b);

/** Dates in order: negative when `a` comes first. */
export const compareDates = (a: PlanDate, b: PlanDate) => stamp(a) - stamp(b);

/** The date `n` days after (before, if negative). */
export function addDays(p: PlanDate, n: number): PlanDate {
  const date = new Date(p.y, p.m - 1, p.d + n);
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** The date of the day whose list `todo` is; null for any other bullet. */
export function dateOfList(doc: Doc, list: NodeId): PlanDate | null {
  if (!doc.has(list) || !isTodo(doc, list)) return null;
  const p = periodAt(doc, doc.get(list).parent!);
  return p?.kind === 'day' ? { y: p.y, m: p.m, d: p.d } : null;
}

/**
 * The plans of a bullet (of any copy of it) for `from` and the days after:
 * its mirrors right in the `todo` of such a day, the earliest day first.
 * Mirrors in the lists of days gone by are history, not plans.
 */
export function plansOf(doc: Doc, id: NodeId, from: PlanDate): Plan[] {
  const origin = doc.origin(id);
  const out: Plan[] = [];
  for (const star of doc.copies(origin)) {
    if (star === origin) continue;
    const todo = doc.get(star).parent;
    if (todo === null || todo === TRASH || !doc.has(todo)) continue;
    const date = dateOfList(doc, todo);
    if (date && compareDates(date, from) >= 0) out.push({ star, todo, date });
  }
  return out.sort((a, b) => compareDates(a.date, b.date));
}

/**
 * Can the bullet be planned: one that can be starred anywhere, and not one
 * written right in a day's `todo`, which is on that day already.
 */
export function plannable(doc: Doc, id: NodeId): boolean {
  if (!starrable(doc, id, null)) return false;
  const parent = doc.get(doc.origin(id)).parent;
  return parent === null || firstWord(doc.get(parent).text) !== TODO || !isTodo(doc, parent);
}

/**
 * The plan chosen on rows (the calendar's day, Outliner.planFor): the
 * bullets' mirrors in the lists of days to come go to the trash, and, with a
 * `todo`, one goes in it: last, but above the empty bullets at its end. A
 * bullet planned for that day already stays. With `todo` null the plans are
 * only taken away. Rows that cannot be planned are left out (a row of the
 * list that is a mirror stands for its bullet). Returns what it did: 'on'
 * for planned, 'off' for cancelled, null for nothing changed.
 */
export function planStars({ doc }: Ctx, keys: RowKey[], todo: NodeId | null, from: PlanDate): 'on' | 'off' | null {
  const origins: NodeId[] = [];
  for (const key of keys) {
    const id = nodeOf(key);
    if (!doc.has(id) || !plannable(doc, id)) continue;
    const origin = doc.origin(id);
    if (!origins.includes(origin)) origins.push(origin);
  }
  const fresh: NodeId[] = [];
  let dropped = 0;
  for (const origin of origins) {
    let there = false;
    for (const plan of plansOf(doc, origin, from)) {
      if (plan.todo === todo && !there) {
        there = true;
        continue;
      }
      dropStar(doc, plan.star);
      dropped++;
    }
    if (todo !== null && !there) fresh.push(origin);
  }
  if (todo === null) return dropped ? 'off' : null;
  putStars(doc, todo, starIndex(doc, todo), fresh);
  return fresh.length || dropped ? 'on' : null;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** A plan's date for people: «сегодня», «завтра», else «30 окт» (with the year, if it is not this one). */
export function planLabel(date: PlanDate, today: PlanDate): string {
  const days = Math.round((Date.UTC(date.y, date.m - 1, date.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `${date.d} ${MONTHS[date.m - 1]}${date.y === today.y ? '' : ` ${date.y}`}`;
}

/** The cells of a month's grid, weeks from Monday: the day of the month, null for the blanks around. */
export function monthCells(y: number, m: number): (number | null)[] {
  const cells: (number | null)[] = Array((new Date(y, m - 1, 1).getDay() + 6) % 7).fill(null);
  for (let d = 1; d <= daysIn(y, m); d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/** The tasks of a bullet: itself if it is one, and every one inside; a mirror inside counts as its original, its tree not walked again. */
function tasksOf(doc: Doc, id: NodeId): OutlineNode[] {
  const out: OutlineNode[] = [];
  const seen = new Set<NodeId>();
  const stack = [doc.origin(id)];
  while (stack.length) {
    const cur = stack.pop()!;
    const n = doc.content(cur);
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (n.todo) out.push(n);
    if (!doc.get(cur).mirrorOf) for (const c of doc.get(cur).children) stack.push(c);
  }
  return out;
}

/** Was the task done by `end`: checked before it, or checked before the app kept when (no `doneAt`). */
const doneBy = (t: OutlineNode, end: number) => t.done && (t.doneAt === undefined || t.doneAt < end);

/**
 * How a starred bullet stood at the end of a day (`end`, the stamp of the
 * next midnight; Infinity for now): 'done' if it is a task done by then, or
 * holds tasks and all there by then were done by then; 'open' if something
 * was left to do; null for a bullet with no tasks, nothing to finish.
 */
export function standing(doc: Doc, id: NodeId, end = Infinity): 'done' | 'open' | null {
  const own = doc.content(doc.origin(id));
  if (own.todo) return doneBy(own, end) ? 'done' : 'open';
  const tasks = tasksOf(doc, id).filter((t) => t.created < end);
  if (!tasks.length) return null;
  return tasks.every((t) => doneBy(t, end)) ? 'done' : 'open';
}

/** The stamps a calendar day begins and ends at, on the device's clock. */
export function dayBounds(y: number, m: number, d: number): { start: number; end: number } {
  return { start: new Date(y, m - 1, d).getTime(), end: new Date(y, m - 1, d + 1).getTime() };
}

/**
 * Carries the stars on into a new day's list `todo`: those of the last day
 * before it whose list was made by that day's end (made later, the day was
 * only looked into afterwards and never was "today"), each whose bullet
 * still has an unchecked task, itself or inside (`standing` 'open'): a
 * bullet with nothing to check, or with all of it done, stays behind.
 * They go first in the list, in their order there, folded; the day before
 * keeps its own as they were. `before(n)` gives the list of the day n days
 * back and when that day ended, or null. Returns how many came.
 */
export function carryStars({ doc }: Ctx, todo: NodeId, before: (back: number) => { todo: NodeId; end: number } | null, limit = 366): number {
  for (let back = 1; back <= limit; back++) {
    const day = before(back);
    if (!day || doc.get(day.todo).created >= day.end) continue;
    const origins: NodeId[] = [];
    for (const c of doc.get(day.todo).children) {
      if (!doc.get(c).mirrorOf) continue;
      const origin = doc.origin(c);
      if (origins.includes(origin) || !starrable(doc, origin, todo) || starsIn(doc, todo, origin).length) continue;
      if (standing(doc, origin) === 'open') origins.push(origin);
    }
    putStars(doc, todo, 0, origins);
    return origins.length;
  }
  return 0;
}
