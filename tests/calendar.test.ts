import { describe, expect, it } from 'vitest';
import {
  calendarTree, createCalendar, dayOf, findCalendar, findPeriod, findYear, neighbour, openYear, periodAt, periodOf, periodText,
  type Period,
} from '../src/model/calendar';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import type { Tree } from '../src/model/outline-text';
import { TagIndex } from '../src/model/tags';
import { dump, setup } from './helpers';

const count = (t: Tree): number => 1 + t.children.reduce((n, c) => n + count(c), 0);
const day = (m: number, d: number): Period => ({ kind: 'day', m, d });

describe('calendar tree', () => {
  it('has 4 quarters, 12 months and 366 days, named by tags with two digits', () => {
    const t = calendarTree();
    expect(count(t)).toBe(1 + 4 + 12 + 366);
    expect(t.text).toBe('@календарь');
    expect(t.children.map((q) => q.text)).toEqual(['@q1', '@q2', '@q3', '@q4']);
    const feb = t.children[0].children[1];
    expect(feb.text).toBe('@m02');
    expect(feb.children.map((d) => d.text).slice(-2)).toEqual(['@d28 @m02', '@d29 @m02']);
    expect(t.children[3].children[0].children[18].text).toBe('@d19 @m10');
  });
});

describe('periodOf', () => {
  it('reads a period from the bullet’s own tags', () => {
    expect(periodOf('@d19 @m10')).toEqual(day(10, 19));
    expect(periodOf('@m10 @d19 планы')).toEqual(day(10, 19));
    expect(periodOf('@m10')).toEqual({ kind: 'month', m: 10 });
    expect(periodOf('@q4')).toEqual({ kind: 'quarter', q: 4 });
    expect(periodText(periodOf('@d01 @m01')!)).toBe('@d01 @m01');
  });

  it('is null for other bullets and impossible dates', () => {
    expect(periodOf('@y2026')).toBeNull();
    expect(periodOf('созвон')).toBeNull();
    expect(periodOf('@d31 @m02')).toBeNull();
    expect(periodOf('@m13')).toBeNull();
    expect(periodOf('@m1')).toBeNull();
    expect(periodOf('@d19')).toBeNull();
    expect(periodOf('@q5')).toBeNull();
  });
});

describe('neighbour', () => {
  it('steps over months and the year’s end', () => {
    expect(neighbour(day(10, 31), 1, 2026)).toEqual(day(11, 1));
    expect(neighbour(day(11, 1), -1, 2026)).toEqual(day(10, 31));
    expect(neighbour(day(12, 31), 1, 2026)).toEqual(day(1, 1));
    expect(neighbour(day(1, 1), -1, 2026)).toEqual(day(12, 31));
  });

  it('skips 29 February in a common year only', () => {
    expect(neighbour(day(2, 28), 1, 2026)).toEqual(day(3, 1));
    expect(neighbour(day(3, 1), -1, 2026)).toEqual(day(2, 28));
    expect(neighbour(day(2, 28), 1, 2028)).toEqual(day(2, 29));
    expect(neighbour(day(3, 1), -1, 2028)).toEqual(day(2, 29));
    expect(neighbour(day(2, 28), 1, 2100)).toEqual(day(3, 1));
    expect(neighbour(day(2, 28), 1, 2000)).toEqual(day(2, 29));
  });

  it('wraps months and quarters', () => {
    expect(neighbour({ kind: 'month', m: 12 }, 1, 2026)).toEqual({ kind: 'month', m: 1 });
    expect(neighbour({ kind: 'month', m: 1 }, -1, 2026)).toEqual({ kind: 'month', m: 12 });
    expect(neighbour({ kind: 'quarter', q: 4 }, 1, 2026)).toEqual({ kind: 'quarter', q: 1 });
  });

  it('takes the date of a Date', () => {
    expect(dayOf(new Date(2026, 9, 19, 23, 59))).toEqual(day(10, 19));
  });
});

describe('finding periods', () => {
  const lines = [
    'проект',
    '  созвон @d19 @m10',
    '@календарь',
    '  @q4',
    '    @m10',
    '      @d18 @m10',
    '      @d19 @m10',
    '        @y2026',
    '          запись @d19 @m10',
    '      @d20 @m10',
  ];

  it('finds the calendar, the day, the month and the quarter by their tags', () => {
    const { doc } = setup(lines);
    const tags = new TagIndex(doc);
    const cal = findCalendar(doc, tags)!;
    expect(cal).toBe('@календарь');
    // Not the entry that mentions the day, inside the day or elsewhere.
    expect(findPeriod(doc, tags, cal, day(10, 19))).toBe('@d19 @m10');
    expect(findPeriod(doc, tags, cal, { kind: 'month', m: 10 })).toBe('@m10');
    expect(findPeriod(doc, tags, cal, { kind: 'quarter', q: 4 })).toBe('@q4');
    expect(findPeriod(doc, tags, cal, day(10, 21))).toBeNull();
  });

  it('follows a renamed day, and loses one without its tags', () => {
    const { doc, run } = setup(lines.slice(0, 7));
    const tags = new TagIndex(doc);
    run(() => doc.apply({ t: 'setText', id: '@d19 @m10', from: '@d19 @m10', to: '@d19 @m10 день рождения' }));
    expect(findPeriod(doc, tags, '@календарь', day(10, 19))).toBe('@d19 @m10');
    run(() => doc.apply({ t: 'setText', id: '@d19 @m10', from: '@d19 @m10 день рождения', to: 'день рождения' }));
    expect(findPeriod(doc, tags, '@календарь', day(10, 19))).toBeNull();
  });

  it('never takes an entry in another day for a missing day', () => {
    const { doc } = setup([...lines, '        созвон @d24 @m10', '        @m11']);
    const tags = new TagIndex(doc);
    expect(findPeriod(doc, tags, '@календарь', day(10, 24))).toBeNull();
    expect(findPeriod(doc, tags, '@календарь', { kind: 'month', m: 11 })).toBeNull();
    expect(periodAt(doc, '@календарь', '@d20 @m10')).toEqual(day(10, 20));
    expect(periodAt(doc, '@календарь', 'запись @d19 @m10')).toBeNull();
    expect(periodAt(doc, '@календарь', 'созвон @d19 @m10')).toBeNull();
  });

  it('finds the year’s bullet among the day’s children', () => {
    const { doc } = setup(lines);
    expect(findYear(doc, '@d19 @m10', 2026)).toBe('@y2026');
    expect(findYear(doc, '@d19 @m10', 2025)).toBeNull();
  });
});

describe('openYear', () => {
  it('makes this year’s bullet first, with an empty entry for the caret; undone whole', () => {
    const { doc, ctx, run } = setup(['@календарь', '  @d19 @m10', '    @y2025', '      было']);
    const before = dump(doc);
    const ops = doc.transact(() => {
      const f = openYear(ctx, '@d19 @m10', 2026);
      expect(doc.get(f.id).text).toBe('');
      expect(doc.get(doc.get(f.id).parent!).text).toBe('@y2026');
    });
    expect(dump(doc)).toEqual(['@календарь', '  @d19 @m10', '    @y2026', '      ', '    @y2025', '      было']);
    checkInvariants(doc);
    run(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dump(doc)).toEqual(before);
  });

  it('opens an existing year at the end of its last entry, unfolding it, and adds nothing', () => {
    const { doc, ctx, run } = setup(['@календарь', '  @d19 @m10', '    @y2026 [+]', '      утро', '      вечер']);
    const f = run(() => openYear(ctx, '@d19 @m10', 2026));
    expect(f).toEqual({ id: 'вечер', caret: 5 });
    expect(dump(doc)).toEqual(['@календарь', '  @d19 @m10', '    @y2026', '      утро', '      вечер']);
  });
});

describe('createCalendar', () => {
  it('puts the whole calendar last at the top level, quarters folded', () => {
    const { doc, ctx, rows, run } = setup(['а']);
    const cal = run(() => createCalendar(ctx));
    expect(doc.get(doc.root).children).toEqual(['а', cal]);
    const tags = new TagIndex(doc);
    expect(findCalendar(doc, tags)).toBe(cal);
    expect(doc.get(cal).children.every((q) => doc.get(q).collapsed)).toBe(true);
    expect(rows.length).toBe(1 + 1 + 4);
    expect(findPeriod(doc, tags, cal, day(2, 29))).not.toBeNull();
    checkInvariants(doc);
  });
});
