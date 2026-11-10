import { describe, expect, it } from 'vitest';
import { addYear, createStructure, findCalendar, findPeriod, hasStructure, openPeriods, packCalendar, yearTags } from '../src/model/calendar';
import { applyMerged } from '../src/model/merge';
import { invert } from '../src/model/doc';
import { VisibleRows } from '../src/model/rows';
import { TagIndex } from '../src/model/tags';
import { checkInvariants } from '../src/model/invariants';
import { deserialize, serialize } from '../src/persist/serialize';
import { resolveLink } from '../src/model/links';
import { TextIndex } from '../src/model/search';
import { dump, setup } from './helpers';

const texts = (doc: ReturnType<typeof setup>['doc'], parent: string) => doc.get(parent).children.map((id) => doc.content(id).text);

describe('Calendar container', () => {
  it.each(['Calendar', '📅 Calendar', 'My Calendar — личное', '**CALENDAR**', 'Calendar @y26'])('recognizes an embellished root title: %s', (title) => {
    const { doc, ctx, run } = setup(['Projects', '  Calendar nested', 'CalendarNotes', 'Calendars', title]);
    expect(findCalendar(doc)).toBe(title);
    expect(hasStructure(doc, new TagIndex(doc))).toBe(true);
    expect(run(() => addYear(ctx, new TagIndex(doc), 2026))).toBe(true);
    expect(texts(doc, title)).toEqual(['@y26']);
    expect(doc.get(title).text).toBe(title);
    expect(findPeriod(doc, new TagIndex(doc), { kind: 'day', y: 2026, m: 12, d: 31 })).not.toBeNull();
  });

  it('uses the first root Calendar, excludes substring matches and nested Calendar', () => {
    expect(findCalendar(setup(['Calendars', 'CalendarNotes', 'Projects', '  Calendar']).doc)).toBeNull();
    const { doc, ctx, run } = setup(['📅 Calendar', '  personal', 'Second Calendar', '  @y2027', '  other']);
    run(() => addYear(ctx, new TagIndex(doc), 2027));
    expect(texts(doc, '📅 Calendar')).toEqual(['@y27', 'personal']);
    expect(texts(doc, 'Second Calendar')).toEqual(['@y2027', 'other']);
    const before = dump(doc);
    expect(run(() => addYear(ctx, new TagIndex(doc), 2027))).toBe(false);
    expect(dump(doc)).toEqual(before);
  });

  it('packs root years newest first without changing IDs, content, state, links or other root order', () => {
    const { doc, ctx, run } = setup([
      'Inbox', '@y25 [+]', '  @m01 [+]', '    @w01', '      @d01 @m01 @y25', '        My note',
      'Project', '@y26 [+]', 'Link [[@d01 @m01 @y25]]', 'Copy',
    ]);
    run(() => doc.apply({ t: 'setMirror', id: 'Copy', from: null, to: '@d01 @m01 @y25' }));
    const day = doc.get('@d01 @m01 @y25');
    const index = new TextIndex(doc);
    expect(run(() => packCalendar(ctx)).changed).toBe(true);
    const calendar = findCalendar(doc)!;
    expect(texts(doc, doc.root)).toEqual(['Inbox', 'Calendar', 'Project', 'Link [[@d01 @m01 @y25]]', '@d01 @m01 @y25']);
    expect(texts(doc, calendar)).toEqual(['@y26', '@y25']);
    expect(doc.get('@y25').collapsed).toBe(true);
    expect(doc.get('@m01').collapsed).toBe(true);
    expect(doc.get('@d01 @m01 @y25')).toBe(day);
    expect(doc.get('Copy').mirrorOf).toBe(day.id);
    expect(resolveLink(doc, index, day.text)).toBe(day.id);
    const before = serialize(doc);
    expect(run(() => packCalendar(ctx)).changed).toBe(false);
    expect(serialize(doc)).toEqual(before);
    checkInvariants(doc);
  });

  it('preserves existing Calendar years and personal child order when packing and adding a year', () => {
    const { doc, ctx, run } = setup(['📅 Calendar work', '  personal', '  @y24', '  next', '@y26', '@y25']);
    run(() => packCalendar(ctx));
    expect(texts(doc, '📅 Calendar work')).toEqual(['@y26', '@y25', 'personal', '@y24', 'next']);
    run(() => addYear(ctx, new TagIndex(doc), 2027));
    expect(texts(doc, '📅 Calendar work')).toEqual(['@y27', '@y26', '@y25', 'personal', '@y24', 'next']);
    run(() => createStructure(ctx, 2027));
    expect(doc.get(doc.root).children.filter((id) => doc.content(id).text.includes('Calendar'))).toEqual(['📅 Calendar work']);
    expect(texts(doc, '📅 Calendar work').filter((t) => t === '@y27')).toHaveLength(1);
  });

  it.each([
    ['@y26', '@y2026'],
    ['Calendar', '  @y26', '@y2026'],
  ])('rejects duplicate-year packing before any mutation: %j', (...lines) => {
    const { doc, ctx, run } = setup(lines);
    const before = serialize(doc);
    expect(run(() => packCalendar(ctx)).error).toContain('повторяется');
    expect(serialize(doc)).toEqual(before);
    expect(run(() => createStructure(ctx, 2026))).toBe(doc.root);
    expect(serialize(doc)).toEqual(before);
  });

  it('uses the original storage of a root Calendar mirror without a cycle', () => {
    const { doc, ctx, run } = setup(['Projects', '  Calendar original', '    @y25', 'Copy', '@y26']);
    run(() => doc.apply({ t: 'setMirror', id: 'Copy', from: null, to: 'Calendar original' }));
    expect(findCalendar(doc)).toBe('Calendar original');
    expect(run(() => packCalendar(ctx)).changed).toBe(true);
    expect(texts(doc, 'Calendar original')).toEqual(['@y26', '@y25']);
    expect(findPeriod(doc, new TagIndex(doc), { kind: 'year', y: 2025 })).toBe('@y25');
    run(() => addYear(ctx, new TagIndex(doc), 2027));
    expect(texts(doc, 'Calendar original')[0]).toBe('@y27');
    checkInvariants(doc);
  });

  it('detects a Calendar mirror whose storage is inside a root year and never creates a cycle', () => {
    const { doc, ctx, run } = setup(['@y26', '  Calendar original', 'Copy']);
    run(() => doc.apply({ t: 'setMirror', id: 'Copy', from: null, to: 'Calendar original' }));
    const before = serialize(doc);
    expect(run(() => packCalendar(ctx)).error).toContain('внутри');
    expect(serialize(doc)).toEqual(before);
  });

  it('recognizes periods, fold cleanup and year tag normalization inside Calendar', () => {
    const { doc } = setup(['Calendar', '  @y2026', '    @m10 [+]', '      @w43', '        @d19 @m10', '          note']);
    expect(openPeriods(doc)).toEqual(['@y2026', '@w43']);
    expect(yearTags(doc)).toEqual([{ id: '@y2026', text: '@y26' }, { id: '@d19 @m10', text: '@d19 @m10 @y26' }]);
    expect(findPeriod(doc, new TagIndex(doc), { kind: 'day', y: 2026, m: 10, d: 19 })).toBe('@d19 @m10');
  });

  it('simultaneous automatic packing and next-year creation converge through sync and rebase', () => {
    const { doc: base } = setup(['Inbox', '@y25', '@y26', 'Project']);
    const a = deserialize(serialize(base)), b = deserialize(serialize(base)), server = deserialize(serialize(base));
    const build = (doc: typeof base) => doc.transact(() => {
      const ctx = { doc, rows: new VisibleRows(doc) };
      packCalendar(ctx);
      addYear(ctx, new TagIndex(doc), 2027);
    });
    const fromA = build(a), fromB = build(b);
    for (const op of [...fromA, ...fromB]) applyMerged(server, op);
    b.transact(() => {
      for (const op of [...fromB].reverse()) applyMerged(b, invert(op));
      for (const op of [...fromA, ...fromB]) applyMerged(b, op);
    });
    expect(dump(b)).toEqual(dump(server));
    expect(dump(a)).toEqual(dump(server));
    expect(texts(server, findCalendar(server)!)).toEqual(['@y27', '@y26', '@y25']);
    expect(texts(server, server.root)).toEqual(['Inbox', 'Calendar', 'Project']);
    checkInvariants(server);
  });
});
