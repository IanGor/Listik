import { describe, expect, it } from 'vitest';
import { calendarPlan, rebuildCalendar } from '../src/model/calendar-migration';
import { findPeriod, periodAt, yearTags } from '../src/model/calendar';
import { History } from '../src/model/history';
import { invert } from '../src/model/doc';
import { applyMerged } from '../src/model/merge';
import { VisibleRows } from '../src/model/rows';
import { resolveLink } from '../src/model/links';
import { TextIndex } from '../src/model/search';
import { TagIndex } from '../src/model/tags';
import { checkInvariants } from '../src/model/invariants';
import { deserialize, serialize } from '../src/persist/serialize';
import { dump, setup } from './helpers';

const legacy = [
  'Inbox', '@q4', '  @y26', '    @m10 [+]', '      @w43 [+]', '        @d19 @m10 @y26 @понедельник', '          Моя запись',
  '@q1', '  @y2026', '    @m01 [+]', '      @w01', '        @d01 @m01 @y26 @четверг', 'Проекты',
];
const rootTexts = (doc: ReturnType<typeof setup>['doc']) => doc.get(doc.root).children.map((id) => doc.get(id).text);

describe('rebuild calendar', () => {
  it('moves existing months under the first Q1 year, preserves contents and IDs; undo/redo is one step', () => {
    const { doc, ctx, run } = setup([...legacy, 'Ссылка [[@d19 @m10 @y26 @понедельник]]', 'Копия дня']);
    run(() => doc.apply({ t: 'setMirror', id: 'Копия дня', from: null, to: '@d19 @m10 @y26 @понедельник' }));
    const index = new TextIndex(doc);
    const before = dump(doc);
    const note = doc.get('Моя запись');
    const history = new History();
    const ops = doc.transact(() => expect(rebuildCalendar(ctx)).toEqual({ changed: true, retained: [] }));
    history.record({ ops, before: null, after: null });
    expect(rootTexts(doc)).toEqual(['Inbox', '@y2026', 'Проекты', 'Ссылка [[@d19 @m10 @y26 @понедельник]]', 'Копия дня']);
    expect(resolveLink(doc, index, '@d19 @m10 @y26 @понедельник')).toBe('@d19 @m10 @y26 @понедельник');
    expect(doc.get('Копия дня').mirrorOf).toBe('@d19 @m10 @y26 @понедельник');
    expect(doc.get('@y2026').children).toEqual(['@m01', '@m10']);
    expect(doc.get('@m10').collapsed).toBe(true);
    expect(doc.get('@w43').collapsed).toBe(true);
    expect(doc.get('Моя запись')).toBe(note);
    expect(findPeriod(doc, new TagIndex(doc), { kind: 'day', y: 2026, m: 10, d: 19 })).toBe('@d19 @m10 @y26 @понедельник');
    const after = dump(doc);
    expect(rebuildCalendar(ctx).changed).toBe(false);
    history.undo(doc);
    expect(dump(doc)).toEqual(before);
    history.redo(doc);
    expect(dump(doc)).toEqual(after);
    checkInvariants(doc);
  });

  it('keeps shells with notes, personal children, links, sketches and mirrors', () => {
    const { doc, ctx, run } = setup([
      ...legacy, 'Ссылка [[@q4]]', 'Зеркало',
    ]);
    run(() => {
      doc.apply({ t: 'setMirror', id: 'Зеркало', from: null, to: '@y26' });
      doc.apply({ t: 'setNote', id: '@q1', from: '', to: 'Моя заметка' });
      doc.apply({ t: 'addStrokes', id: '@q4', strokes: [{ id: 'stroke', tool: 'pen', d: 'M0 0L1 1' }] });
    });
    const result = run(() => rebuildCalendar(ctx));
    expect(result.changed).toBe(true);
    expect(result.retained.join(' ')).toContain('@q4');
    expect(result.retained.join(' ')).toContain('@q1');
    expect(doc.inOutline('@q4')).toBe(true);
    expect(doc.inOutline('@q1')).toBe(true);
    expect(doc.inOutline('@y26')).toBe(true);
    expect(doc.get('Зеркало').mirrorOf).toBe('@y26');
    expect(doc.get('@q1').note).toBe('Моя заметка');
    expect(run(() => rebuildCalendar(ctx)).changed).toBe(false);
    checkInvariants(doc);
  });

  it('retains personal entries at their shells, uses an existing root year and sorts root years', () => {
    const { doc, ctx, run } = setup([
      '@y25', 'Inbox', '@q4', '  @y26', '    @m10', '    созвон @d20 @m10',
      '@q1', '  @y2026', '    @m01', '@y2025', '  @m02', 'Проекты',
    ]);
    // Give the existing root year 2026, then verify it receives the legacy months.
    run(() => doc.apply({ t: 'setText', id: '@y2025', from: '@y2025', to: '@y26' }));
    const result = run(() => rebuildCalendar(ctx));
    expect(result.changed).toBe(true);
    expect(doc.get('@y2025').children).toEqual(['@m01', '@m02', '@m10']);
    expect(doc.get('созвон @d20 @m10').parent).toBe('@y26');
    expect(doc.inOutline('@q4')).toBe(true);
    expect(rootTexts(doc)).toEqual(['Inbox', '@y25', '@y26', '@q4', 'Проекты']);
    checkInvariants(doc);
  });

  it.each([
    ['@q1', '  @y26', '    @m01', '@q2', '  @y2026', '    @m01 дубль'],
    ['@q1', '  @y26', '    @m99'],
    ['@y26', '@y2026', '@q1', '  @y26 old', '    @m01'],
    ['@q1', '  @y26', '    @m01', '      @d01 @m01'],
  ])('rejects conflicts without partial mutations: %j', (...lines) => {
    const { doc, ctx, run } = setup(lines);
    const before = serialize(doc);
    expect(calendarPlan(doc).error).toBeTruthy();
    expect(run(() => rebuildCalendar(ctx)).changed).toBe(false);
    expect(serialize(doc)).toEqual(before);
  });

  it('is a no-op without a legacy calendar, and can migrate an empty legacy year', () => {
    for (const lines of [[], ['Inbox'], ['@y26', '  @m01']]) {
      const { doc, ctx, run } = setup(lines);
      const before = serialize(doc);
      expect(run(() => rebuildCalendar(ctx)).changed).toBe(false);
      expect(serialize(doc)).toEqual(before);
    }
    const { doc, ctx, run } = setup(['@q1', '  @y26']);
    expect(run(() => rebuildCalendar(ctx)).changed).toBe(true);
    expect(rootTexts(doc)).toEqual(['@y26']);
  });

  it('concurrent migrations converge through the sync merge and rebase without duplicating nodes', () => {
    const { doc: base } = setup(legacy);
    const a = deserialize(serialize(base)), b = deserialize(serialize(base)), server = deserialize(serialize(base));
    const migrate = (doc: typeof base) => doc.transact(() => rebuildCalendar({ doc, rows: new VisibleRows(doc) }));
    const fromA = migrate(a), fromB = migrate(b);
    for (const op of [...fromA, ...fromB]) applyMerged(server, op);
    b.transact(() => {
      for (const op of [...fromB].reverse()) applyMerged(b, invert(op));
      for (const op of [...fromA, ...fromB]) applyMerged(b, op);
    });
    expect(dump(b)).toEqual(dump(server));
    expect(dump(server)).toEqual(dump(a));
    for (const doc of [a, b, server]) {
      expect(doc.get('@y2026').children).toEqual(['@m01', '@m10']);
      checkInvariants(doc);
    }
  });

  it('recognizes root-year dates and normalizes their tags without touching entries inside days', () => {
    const { doc } = setup(['@y2026', '  @m10', '    @w43', '      @d19 @m10', '        запись @d20 @m10']);
    expect(periodAt(doc, '@y2026')).toEqual({ kind: 'year', y: 2026 });
    expect(yearTags(doc)).toEqual([{ id: '@y2026', text: '@y26' }, { id: '@d19 @m10', text: '@d19 @m10 @y26' }]);
    expect(periodAt(doc, 'запись @d20 @m10')).toBeNull();
  });
});
