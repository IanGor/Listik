import { describe, expect, it } from 'vitest';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { addDays, carryStars, compareDates, dateOfList, dayBounds, doneWithin, isTodo, monthCells, planLabel, planStars, plannable, plansOf, standing, starrable, starsIn, todoOf, type PlanDate } from '../src/model/today';
import type { NodeId } from '../src/model/types';
import { setup } from './helpers';

const FRI = '@d23 @m10 @y26 @пятница';
const MON = '@d26 @m10 @y26 @понедельник';
const FRI_TODO = 'todo';
const FRI_D: PlanDate = { y: 2026, m: 10, d: 23 };
const MON_D: PlanDate = { y: 2026, m: 10, d: 26 };
const MON_TODO = 'todo на понедельник';

function calendar() {
  const t = setup([
    '@q4', '  @y26', '    @m10',
    '      @w43', `        ${FRI}`, `          ${FRI_TODO}`,
    '      @w44', `        ${MON}`, '          #notes', `          ${MON_TODO}`, '            записано', '            ',
    'PARA', '  Проект А', '    шаг 1', '    шаг 2', '  Проект Б', '  Задача В', '  Готовый', '    сделано',
    'тайное #secret', '  внутри',
  ]);
  const task = (id: NodeId, done = false, at?: number) => {
    t.doc.apply({ t: 'setTodo', id, from: false, to: true });
    if (done) t.doc.apply({ t: 'setDone', id, from: false, to: true, ...(at !== undefined ? { at } : {}) });
  };
  task('шаг 1');
  task('шаг 2');
  task('Задача В');
  task('сделано', true, 5);
  return { ...t, task };
}

const titles = (doc: ReturnType<typeof calendar>['doc'], todo: NodeId) =>
  doc.get(todo).children.map((c) => (doc.get(c).mirrorOf ? `★ ${doc.content(c).text}` : doc.get(c).text));

describe('the star: a mirror in today\'s todo', () => {
  it('finds a day\'s todo by its first word, and knows it for one', () => {
    const { doc } = calendar();
    expect(todoOf(doc, MON)).toBe(MON_TODO);
    expect(isTodo(doc, MON_TODO)).toBe(true);
    expect(isTodo(doc, 'Проект А')).toBe(false);
  });

  it('planning puts a folded mirror last in the day\'s list, above the empty bullet; planning for that day again changes nothing; cancelling takes it away', () => {
    const { doc, ctx, run } = calendar();
    expect(run(() => planStars(ctx, ['Проект А'], MON_TODO, MON_D))).toBe('on');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '★ Проект А', '']);
    const [plan] = plansOf(doc, 'Проект А', MON_D);
    expect(plan).toMatchObject({ todo: MON_TODO, date: MON_D });
    expect(doc.get(plan.star)).toMatchObject({ mirrorOf: 'Проект А', collapsed: true });
    // The mirror itself, as a row of the list, is the same bullet's plan.
    expect(plansOf(doc, plan.star, MON_D).map((p) => p.star)).toEqual([plan.star]);
    expect(run(() => planStars(ctx, ['Проект А'], MON_TODO, MON_D))).toBeNull();
    expect(titles(doc, MON_TODO)).toEqual(['записано', '★ Проект А', '']);
    expect(run(() => planStars(ctx, [plan.star], null, MON_D))).toBe('off');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
    expect(plansOf(doc, 'Проект А', MON_D)).toEqual([]);
    expect(run(() => planStars(ctx, ['Проект А'], null, MON_D))).toBeNull();
    checkInvariants(doc);
  });

  it('a bullet is planned for one day: a new date moves it', () => {
    const { doc, ctx, run } = calendar();
    run(() => planStars(ctx, ['Проект А'], MON_TODO, FRI_D));
    expect(run(() => planStars(ctx, ['Проект А'], FRI_TODO, FRI_D))).toBe('on');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
    expect(titles(doc, FRI_TODO)).toEqual(['★ Проект А']);
    expect(plansOf(doc, 'Проект А', FRI_D).map((p) => p.date)).toEqual([FRI_D]);
    checkInvariants(doc);
  });

  it('a mirror in the list of a day gone by is history, not a plan: planning leaves it, cancelling too', () => {
    const { doc, ctx, run } = calendar();
    run(() => planStars(ctx, ['Проект А'], FRI_TODO, FRI_D));
    expect(plansOf(doc, 'Проект А', MON_D)).toEqual([]);
    expect(run(() => planStars(ctx, ['Проект А'], MON_TODO, MON_D))).toBe('on');
    expect(titles(doc, FRI_TODO)).toEqual(['★ Проект А']);
    expect(plansOf(doc, 'Проект А', MON_D).map((p) => p.date)).toEqual([MON_D]);
    expect(run(() => planStars(ctx, ['Проект А'], null, MON_D))).toBe('off');
    expect(titles(doc, FRI_TODO)).toEqual(['★ Проект А']);
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
  });

  it('a selection plans all of them for the day, those planned elsewhere moved; cancelling takes all', () => {
    const { doc, ctx, run } = calendar();
    run(() => planStars(ctx, ['Проект Б'], FRI_TODO, FRI_D));
    expect(run(() => planStars(ctx, ['Проект А', 'Проект Б'], MON_TODO, FRI_D))).toBe('on');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '★ Проект А', '★ Проект Б', '']);
    expect(titles(doc, FRI_TODO)).toEqual([]);
    expect(run(() => planStars(ctx, ['Проект А', 'Проект Б'], null, FRI_D))).toBe('off');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
  });

  it('is one step to undo', () => {
    const { doc, ctx } = calendar();
    const ops = doc.transact(() => planStars(ctx, ['Проект А'], MON_TODO, MON_D));
    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
    checkInvariants(doc);
  });

  it('is not for the calendar, a todo list, a secret, or what is written in a list already', () => {
    const { doc, ctx, run } = calendar();
    for (const id of ['@q4', '@y26', '@m10', '@w44', MON, MON_TODO, 'тайное #secret', 'внутри', 'записано']) {
      expect(plannable(doc, id), id).toBe(false);
    }
    expect(plannable(doc, 'PARA')).toBe(true);
    expect(starrable(doc, 'PARA', MON_TODO)).toBe(true);
    expect(run(() => planStars(ctx, ['внутри', MON], MON_TODO, MON_D))).toBeNull();
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
  });

  it('knows the date of a day\'s list', () => {
    const { doc } = calendar();
    expect(dateOfList(doc, MON_TODO)).toEqual(MON_D);
    expect(dateOfList(doc, FRI_TODO)).toEqual(FRI_D);
    expect(dateOfList(doc, 'Проект А')).toBeNull();
  });
});

describe('dates of plans', () => {
  const today: PlanDate = { y: 2026, m: 10, d: 27 };

  it('says «сегодня» and «завтра», else the date, with the year when it is not this one', () => {
    expect(planLabel(today, today)).toBe('сегодня');
    expect(planLabel({ y: 2026, m: 10, d: 28 }, today)).toBe('завтра');
    expect(planLabel({ y: 2026, m: 10, d: 30 }, today)).toBe('30 окт');
    expect(planLabel({ y: 2026, m: 5, d: 9 }, today)).toBe('9 мая');
    expect(planLabel({ y: 2027, m: 1, d: 2 }, today)).toBe('2 янв 2027');
    // Tomorrow across a month's and a year's end.
    expect(planLabel({ y: 2026, m: 11, d: 1 }, { y: 2026, m: 10, d: 31 })).toBe('завтра');
    expect(planLabel({ y: 2027, m: 1, d: 1 }, { y: 2026, m: 12, d: 31 })).toBe('завтра');
  });

  it('adds days across months and years, and orders dates', () => {
    expect(addDays({ y: 2026, m: 12, d: 31 }, 1)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(addDays({ y: 2026, m: 3, d: 1 }, -1)).toEqual({ y: 2026, m: 2, d: 28 });
    expect(compareDates(today, { y: 2026, m: 11, d: 1 })).toBeLessThan(0);
  });

  it('lays a month out in weeks from Monday', () => {
    // October 2026 begins on a Thursday and ends on a Saturday.
    const cells = monthCells(2026, 10);
    expect(cells.length % 7).toBe(0);
    expect(cells.slice(0, 5)).toEqual([null, null, null, 1, 2]);
    expect(cells.filter((c) => c !== null)).toHaveLength(31);
    expect(cells[cells.length - 1]).toBeNull();
    expect(cells[cells.length - 2]).toBe(31);
    // A month beginning on a Monday has no blanks before it.
    expect(monthCells(2026, 6)[0]).toBe(1);
  });
});

describe('how a starred bullet stands', () => {
  it('a task by its own check; a project by the tasks inside; none inside — nothing to finish', () => {
    const { doc } = calendar();
    expect(standing(doc, 'Задача В')).toBe('open');
    expect(standing(doc, 'Проект А')).toBe('open');
    expect(standing(doc, 'Проект Б')).toBeNull();
    expect(standing(doc, 'Готовый')).toBe('done');
  });

  it('at the end of a day: tasks made later do not count, tasks checked later were open then', () => {
    const { doc, task } = calendar();
    doc.apply({ t: 'setDone', id: 'шаг 1', from: false, to: true, at: 100 });
    doc.apply({ t: 'setDone', id: 'шаг 2', from: false, to: true, at: 200 });
    expect(standing(doc, 'Проект А', 150)).toBe('open');
    expect(standing(doc, 'Проект А', 250)).toBe('done');
    expect(standing(doc, 'Проект А')).toBe('done');
    // A task added since: the day it was all done stays done.
    doc.apply({
      t: 'insert', parent: 'Проект А',
      node: { id: 'шаг 3', order: 'z', text: 'шаг 3', note: '', collapsed: false, todo: false, done: false, created: 300, updated: 300, children: [] },
    });
    task('шаг 3');
    expect(standing(doc, 'Проект А', 250)).toBe('done');
    expect(standing(doc, 'Проект А')).toBe('open');
  });

  it('what was done within a day, in the order of the outline', () => {
    const { doc } = calendar();
    doc.apply({ t: 'setDone', id: 'шаг 2', from: false, to: true, at: 100 });
    doc.apply({ t: 'setDone', id: 'шаг 1', from: false, to: true, at: 120 });
    expect(doneWithin(doc, 'Проект А', 90, 130)).toEqual(['шаг 1', 'шаг 2']);
    expect(doneWithin(doc, 'Проект А', 110, 130)).toEqual(['шаг 1']);
    expect(doneWithin(doc, 'Проект А', 130, 200)).toEqual([]);
    expect(doneWithin(doc, 'Готовый', 0, 10)).toEqual(['сделано']);
    // Done before the app kept when: never "within" a day.
    doc.apply({ t: 'setDone', id: 'Задача В', from: false, to: true });
    expect(doneWithin(doc, 'Задача В', 0, Infinity)).toEqual([]);
  });

  it('day bounds are local midnights', () => {
    const { start, end } = dayBounds(2026, 10, 26);
    expect(new Date(start).getDate()).toBe(26);
    expect(new Date(end).getDate()).toBe(27);
    expect(new Date(end).getHours()).toBe(0);
  });
});

describe('carrying stars on to a new day', () => {
  const fridayEnd = dayBounds(2026, 10, 24).start;

  it('the unfinished and the ones with nothing to finish come first, folded; the done stay behind; the day before keeps its own', () => {
    const { doc, ctx, run } = calendar();
    run(() => planStars(ctx, ['Проект А', 'Проект Б', 'Готовый', 'Задача В'], FRI_TODO, FRI_D));
    doc.apply({ t: 'setDone', id: 'Задача В', from: false, to: true, at: 10 });
    const before = (back: number) => (back === 3 ? { todo: FRI_TODO, end: fridayEnd } : null);
    expect(run(() => carryStars(ctx, MON_TODO, before))).toBe(2);
    expect(titles(doc, MON_TODO)).toEqual(['★ Проект А', '★ Проект Б', 'записано', '']);
    expect(starsIn(doc, MON_TODO, 'Проект А').map((s) => doc.get(s).collapsed)).toEqual([true]);
    expect(titles(doc, FRI_TODO)).toEqual(['★ Проект А', '★ Проект Б', '★ Готовый', '★ Задача В']);
    // Starred already today: not twice.
    expect(run(() => carryStars(ctx, MON_TODO, before))).toBe(0);
    checkInvariants(doc);
  });

  it('skips a day whose list was made after it (looked into later), and stops at the first real one', () => {
    const { doc, ctx, run } = calendar();
    run(() => planStars(ctx, ['Проект А'], FRI_TODO, FRI_D));
    const seen: number[] = [];
    const before = (back: number) => {
      seen.push(back);
      // Monday's list stands in for one made late: made at 0, not before its day's end at 0.
      return back === 1 ? { todo: MON_TODO, end: 0 } : back === 3 ? { todo: FRI_TODO, end: fridayEnd } : null;
    };
    expect(run(() => carryStars(ctx, 'Проект Б', before, 5))).toBe(1);
    expect(seen).toEqual([1, 2, 3]);
    expect(doc.get('Проект Б').children.map((c) => doc.content(c).text)).toEqual(['Проект А']);
  });
});
