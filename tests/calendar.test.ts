import { describe, expect, it } from 'vitest';
import {
  SLOTS, STRUCTURE, addYear, createStructure, dayOf, dayYearTags, fillDay, findInbox, findPeriod, firstWord, findQuarter, hasStructure, isoWeek, periodAt,
  openPeriods, periodName, periodText, structureTrees, weeksOf, yearTree, type Period,
} from '../src/model/calendar';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import type { Tree } from '../src/model/outline-text';
import { TagIndex, parseTags } from '../src/model/tags';
import { dump, dumpRows, setup } from './helpers';

const count = (t: Tree): number => 1 + t.children.reduce((n, c) => n + count(c), 0);
const day = (y: number, m: number, d: number): Period => ({ kind: 'day', y, m, d });

describe('weeks', () => {
  it('are ISO weeks: from Monday, week 1 holds the first Thursday', () => {
    expect(isoWeek(2026, 1, 1)).toBe(1);
    expect(isoWeek(2025, 12, 29)).toBe(1);
    expect(isoWeek(2027, 1, 1)).toBe(53);
    expect(isoWeek(2026, 10, 18)).toBe(42);
    expect(isoWeek(2026, 10, 19)).toBe(43);
  });

  it('of a month: a week spanning two months is in both', () => {
    expect(weeksOf(2026, 10)).toEqual([40, 41, 42, 43, 44]);
    expect(weeksOf(2026, 11)).toEqual([44, 45, 46, 47, 48, 49]);
  });
});

describe('structure', () => {
  it('a year in a quarter: its months, weeks and days, named by tags, all folded', () => {
    const t = yearTree(2026, 4);
    expect(t.text).toBe('@y2026');
    expect(t.children.map((m) => m.text)).toEqual(['@m10', '@m11', '@m12']);
    const oct = t.children[0];
    expect(oct.children.map((w) => w.text)).toEqual(['@w40', '@w41', '@w42', '@w43', '@w44']);
    expect(oct.children[0].children.map((d) => d.text)).toEqual([
      '@d01 @m10 @y26 @четверг', '@d02 @m10 @y26 @пятница', '@d03 @m10 @y26 @суббота', '@d04 @m10 @y26 @воскресенье',
    ]);
    expect(oct.children[3].children[0]).toEqual({ text: '@d19 @m10 @y26 @понедельник', collapsed: true, children: [] });
    expect(count(t)).toBe(1 + 3 + 5 + 6 + 5 + 92);
    // Opening a quarter shows its years, a year its months, and so on: not the ~470 rows of a year.
    expect([t.collapsed, oct.collapsed, oct.children[0].collapsed]).toEqual([true, true, true]);
    expect(yearTree(2028, 1).children[1].children.at(-1)!.children.at(-1)!.text).toBe('@d29 @m02 @y28 @вторник');
  });

  it('nine bullets with notes; the quarters folded, with the year', () => {
    const trees = structureTrees(2026);
    expect(trees.map((t) => t.text)).toEqual(['Inbox', '@q1', '@q2', '@q3', '@q4', 'Projects', 'Hubs', 'Reference', 'Archive']);
    expect(trees.map((t) => t.note)).toEqual(STRUCTURE.map((s) => s.note));
    expect(trees.every((t) => t.note)).toBe(true);
    expect(trees[4].collapsed).toBe(true);
    expect(trees[4].children.map((y) => y.text)).toEqual(['@y2026']);
    expect(trees[0].children).toEqual([]);
  });

  it('goes in last at the top level, whatever is there, and twice if asked', () => {
    const { doc, ctx, rows, run } = setup(['а']);
    const tags = new TagIndex(doc);
    expect(hasStructure(doc, tags)).toBe(false);
    const first = run(() => createStructure(ctx, 2026));
    expect(doc.get(doc.get(doc.root).children[1]).text).toBe('Inbox');
    expect(doc.get(first).text).toBe('Inbox');
    expect(dumpRows(rows, doc)).toEqual(['а', 'Inbox', '@q1 [+]', '@q2 [+]', '@q3 [+]', '@q4 [+]', 'Projects', 'Hubs', 'Reference', 'Archive']);
    expect(hasStructure(doc, tags)).toBe(true);
    const q4 = findQuarter(doc, tags, 4)!;
    expect(findPeriod(doc, tags, day(2026, 2, 28))).not.toBeNull();
    expect(findPeriod(doc, tags, day(2026, 10, 19))).not.toBeNull();
    run(() => createStructure(ctx, 2026));
    expect(doc.get(doc.root).children.length).toBe(1 + 18);
    // The first one stays the calendar.
    expect(findQuarter(doc, tags, 4)).toBe(q4);
    const oct19 = findPeriod(doc, tags, day(2026, 10, 19))!;
    expect(doc.within(oct19, q4)).toBe(true);
    checkInvariants(doc);
  });
});

describe('finding periods', () => {
  const lines = [
    'проект',
    '  созвон @d19 @m10',
    '  @q4 вложенный',
    '@q4',
    '  @y2025',
    '    @m10 прошлый',
    '      @w42',
    '        @d19 @m10 @воскресенье',
    '  @y2026',
    '    @m10',
    '      @w43',
    '        @d19 @m10 @понедельник',
    '          запись @d24 @m10',
    '          @m11 внутри дня',
    '        @d20 @m10 @вторник',
  ];

  it('by tags and the periods around them, year by year', () => {
    const { doc } = setup(lines);
    const tags = new TagIndex(doc);
    expect(findQuarter(doc, tags, 4)).toBe('@q4');
    expect(findPeriod(doc, tags, day(2026, 10, 19))).toBe('@d19 @m10 @понедельник');
    expect(findPeriod(doc, tags, day(2025, 10, 19))).toBe('@d19 @m10 @воскресенье');
    expect(findPeriod(doc, tags, { kind: 'month', y: 2026, m: 10 })).toBe('@m10');
    expect(findPeriod(doc, tags, { kind: 'month', y: 2025, m: 10 })).toBe('@m10 прошлый');
    expect(findPeriod(doc, tags, { kind: 'week', y: 2026, m: 10, w: 43 })).toBe('@w43');
    expect(findPeriod(doc, tags, { kind: 'quarter', y: 2026, q: 4 })).toBe('@y2026');
    expect(findPeriod(doc, tags, { kind: 'quarter', y: 2027, q: 4 })).toBeNull();
  });

  it('never takes an entry for a period, nor a quarter below the top level', () => {
    const { doc } = setup(lines);
    const tags = new TagIndex(doc);
    expect(findPeriod(doc, tags, day(2026, 10, 24))).toBeNull();
    expect(findPeriod(doc, tags, { kind: 'month', y: 2026, m: 11 })).toBeNull();
    expect(periodAt(doc, 'созвон @d19 @m10')).toBeNull();
    expect(periodAt(doc, 'запись @d24 @m10')).toBeNull();
    expect(periodAt(doc, '@m11 внутри дня')).toBeNull();
    expect(periodAt(doc, '@q4 вложенный')).toBeNull();
    expect(findQuarter(doc, tags, 4)).toBe('@q4');
    expect(periodAt(doc, '@d20 @m10 @вторник')).toEqual(day(2026, 10, 20));
    expect(periodAt(doc, '@w43')).toEqual({ kind: 'week', y: 2026, m: 10, w: 43 });
  });

  it('follows a renamed or moved day, and loses one without its tags', () => {
    const { doc, run } = setup(lines);
    const tags = new TagIndex(doc);
    const id = '@d20 @m10 @вторник';
    run(() => doc.apply({ t: 'setText', id, from: id, to: '@d20 @m10 @вторник день рождения' }));
    expect(findPeriod(doc, tags, day(2026, 10, 20))).toBe(id);
    const n = doc.get(id);
    run(() => doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: '@m10', order: doc.orderAt('@m10', 1) } }));
    expect(findPeriod(doc, tags, day(2026, 10, 20))).toBe(id);
    run(() => doc.apply({ t: 'setText', id, from: '@d20 @m10 @вторник день рождения', to: 'день рождения' }));
    expect(findPeriod(doc, tags, day(2026, 10, 20))).toBeNull();
  });
});

describe('days', () => {
  it('takes the date of a Date, and names periods', () => {
    expect(dayOf(new Date(2026, 9, 19, 23, 59))).toEqual(day(2026, 10, 19));
    expect(periodText(day(2026, 10, 19))).toBe('@d19 @m10 @y26 @понедельник');
    // 21 October is a Wednesday in 2026 and again in 2037: one title each, told apart by the year's tag.
    const [a, b] = [periodText(day(2026, 10, 21)), periodText(day(2037, 10, 21))];
    expect(a).not.toBe(b);
    expect(parseTags(a).filter((t) => !parseTags(b).includes(t))).toEqual(['@y26']);
    expect(periodName(day(2026, 10, 19))).toBe('19.10.2026');
    expect(periodName({ kind: 'quarter', y: 2026, q: 4 })).toBe('4 квартал 2026');
  });
});

describe('addYear', () => {
  it('puts the year into each quarter in order, once; undone whole', () => {
    const { doc, ctx, run } = setup([]);
    const tags = new TagIndex(doc);
    run(() => createStructure(ctx, 2026));
    const before = dump(doc);
    const ops = doc.transact(() => {
      expect(addYear(ctx, tags, 2027)).toBe(true);
      expect(addYear(ctx, tags, 2025)).toBe(true);
    });
    for (let q = 1; q <= 4; q++) {
      expect(doc.get(findQuarter(doc, tags, q)!).children.map((y) => doc.get(y).text)).toEqual(['@y2025', '@y2026', '@y2027']);
    }
    expect(findPeriod(doc, tags, day(2027, 1, 1))).not.toBeNull();
    expect(run(() => addYear(ctx, tags, 2027))).toBe(false);
    checkInvariants(doc);
    run(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dump(doc)).toEqual(before);
  });

  it('leaves out a quarter that is gone', () => {
    const { doc, ctx, run } = setup(['@q1', '  @y2026']);
    const tags = new TagIndex(doc);
    expect(run(() => addYear(ctx, tags, 2027))).toBe(true);
    expect(dump(doc).filter((l) => !l.startsWith('    '))).toEqual(['@q1', '  @y2026', '  @y2027 [+]']);
  });

  it('days with their year tag are periods and are found; so are days written without it, which get it', () => {
    const { doc } = setup([
      '@q4', '  @y2026', '    @m10', '      @w43',
      '        @d19 @m10 @понедельник', '        @d20 @m10 @вторник 2026', '        @d21 @m10 @среда день рождения', '        @d22 @m10 @y26 @четверг',
      'Inbox', '  @d23 @m10 @пятница',
    ]);
    const tags = new TagIndex(doc);
    expect(findPeriod(doc, tags, day(2026, 10, 19))).toBe('@d19 @m10 @понедельник');
    expect(findPeriod(doc, tags, day(2026, 10, 22))).toBe('@d22 @m10 @y26 @четверг');
    expect(periodAt(doc, '@d22 @m10 @y26 @четверг')).toEqual(day(2026, 10, 22));
    // Only calendar days lacking it; a plain year left by the version before goes.
    expect(dayYearTags(doc)).toEqual([
      { id: '@d19 @m10 @понедельник', text: '@d19 @m10 @y26 @понедельник' },
      { id: '@d20 @m10 @вторник 2026', text: '@d20 @m10 @y26 @вторник' },
      { id: '@d21 @m10 @среда день рождения', text: '@d21 @m10 @y26 @среда день рождения' },
    ]);
  });

  it('finds the years, months and weeks earlier versions left open, nothing else', () => {
    const { doc } = setup(['@q4', '  @y2026', '    @m10 [+]', '      @w43', '        @d19 @m10 @понедельник', '          #notes', 'Projects', '  @y2026 note', '    x']);
    // A week open inside a folded month too: opening the month later would show its days.
    expect(openPeriods(doc).map((id) => doc.get(id).text)).toEqual(['@y2026', '@w43']);
  });
});

describe('findInbox', () => {
  it('is the first top-level bullet titled Inbox, whatever follows the word', () => {
    expect(findInbox(setup(['а', '  Inbox']).doc)).toBeNull();
    expect(findInbox(setup(['Inboxes', '**inbox** входящие', 'Inbox']).doc)).toBe('**inbox** входящие');
    expect(findInbox(setup([]).doc)).toBeNull();
  });

  it('is found whatever emoji, formatting, brackets or tag marks are around the word', () => {
    for (const title of ['📥 Inbox', '✅ *Inbox* — разобрать', '**INBOX**📥', '[[Inbox]] ⭐', '#inbox', '📥  inbox:']) {
      expect(findInbox(setup(['а', title]).doc), title).toBe(title);
    }
    expect(firstWord('📥 **Inbox** 2026')).toBe('inbox');
    expect(findInbox(setup(['📥 Inboxes']).doc)).toBeNull();
    expect(findInbox(setup(['мой Inbox']).doc)).toBeNull();
  });

  it('a copy of a mirror at the top level gives the bullet that holds its children', () => {
    const { doc, run } = setup(['Проекты', '  📥 Inbox', 'копия']);
    run(() => doc.apply({ t: 'setMirror', id: 'копия', from: null, to: '📥 Inbox' }));
    expect(findInbox(doc)).toBe('📥 Inbox');
  });
});

describe('fillDay', () => {
  it('gives an empty day notes and a todo list, each with an empty plain bullet, then the hours, once', () => {
    const { doc, ctx, run } = setup(['@d19 @m10 @понедельник']);
    const id = '@d19 @m10 @понедельник';
    expect(run(() => fillDay(ctx, id))).toBe(true);
    expect(dump(doc)).toEqual([id, '  #notes', '    ', '  todo', '    ', ...SLOTS.map((s) => `  ${s}`)]);
    const [notes, todo] = doc.get(id).children;
    expect(doc.get(doc.get(notes).children[0]).todo).toBe(false);
    // Plain, like the one under the notes: no checkbox until it is made a task.
    expect(doc.get(doc.get(todo).children[0]).todo).toBe(false);
    expect(SLOTS[0]).toBe('09:00');
    expect(SLOTS.at(-1)).toBe('18:00');
    expect(SLOTS.length).toBe(19);
    expect(run(() => fillDay(ctx, id))).toBe(false);
    checkInvariants(doc);
  });
});
