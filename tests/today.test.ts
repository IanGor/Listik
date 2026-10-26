import { describe, expect, it } from 'vitest';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { carryStars, dayBounds, doneWithin, isTodo, standing, starrable, starsIn, todoOf, toggleStars } from '../src/model/today';
import type { NodeId } from '../src/model/types';
import { setup } from './helpers';

const FRI = '@d23 @m10 @y26 @пятница';
const MON = '@d26 @m10 @y26 @понедельник';
const FRI_TODO = 'todo';
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

  it('starring puts a folded mirror last in the list, above the empty bullet; pressed again it goes', () => {
    const { doc, ctx, run } = calendar();
    expect(run(() => toggleStars(ctx, ['Проект А'], MON_TODO))).toBe('on');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '★ Проект А', '']);
    const [star] = starsIn(doc, MON_TODO, 'Проект А');
    expect(doc.get(star)).toMatchObject({ mirrorOf: 'Проект А', collapsed: true });
    // The star itself, as a row of the list, is the same bullet's star.
    expect(starsIn(doc, MON_TODO, star)).toEqual([star]);
    expect(run(() => toggleStars(ctx, [star], MON_TODO))).toBe('off');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
    expect(starsIn(doc, MON_TODO, 'Проект А')).toEqual([]);
    checkInvariants(doc);
  });

  it('a selection stars the ones not starred yet, and unstars only when all are', () => {
    const { doc, ctx, run } = calendar();
    run(() => toggleStars(ctx, ['Проект Б'], MON_TODO));
    expect(run(() => toggleStars(ctx, ['Проект А', 'Проект Б'], MON_TODO))).toBe('on');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '★ Проект Б', '★ Проект А', '']);
    expect(run(() => toggleStars(ctx, ['Проект А', 'Проект Б'], MON_TODO))).toBe('off');
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
  });

  it('is one step to undo', () => {
    const { doc, ctx } = calendar();
    const ops = doc.transact(() => toggleStars(ctx, ['Проект А'], MON_TODO));
    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
    checkInvariants(doc);
  });

  it('is not for the calendar, a todo list, a secret, or what is written in the list already', () => {
    const { doc, ctx, run } = calendar();
    for (const id of ['@q4', '@y26', '@m10', '@w44', MON, MON_TODO, 'тайное #secret', 'внутри', 'записано']) {
      expect(starrable(doc, id, MON_TODO), id).toBe(false);
    }
    expect(starrable(doc, 'PARA', MON_TODO)).toBe(true);
    expect(run(() => toggleStars(ctx, ['внутри', MON], MON_TODO))).toBeNull();
    expect(titles(doc, MON_TODO)).toEqual(['записано', '']);
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
    run(() => toggleStars(ctx, ['Проект А', 'Проект Б', 'Готовый', 'Задача В'], FRI_TODO));
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
    run(() => toggleStars(ctx, ['Проект А'], FRI_TODO));
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
