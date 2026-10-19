import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { invert } from '../src/model/doc';
import { TagIndex, parseTags, splitTags } from '../src/model/tags';
import type { Op } from '../src/model/types';
import { rng, setup } from './helpers';

describe('parseTags', () => {
  it('finds tags in any script, case-insensitively, with inner hyphens', () => {
    expect(parseTags('Пьер #Пьер и #война-и-мир, #бал. #Пьер #v2_x')).toEqual(['пьер', 'война-и-мир', 'бал', 'v2_x']);
  });

  it('needs a word boundary before # and a letter or digit after it', () => {
    expect(parseTags('a#b mail@x.com#frag ## # #- (#ok) "#нет"')).toEqual(['ok']);
    expect(parseTags('#хвост-')).toEqual(['хвост']);
  });

  it('@tags are a set of their own beside #tags; e-mails are not tags', () => {
    expect(parseTags('встреча @Иван и #иван, (@проект-1) a@mail.ru @')).toEqual(['@иван', 'иван', '@проект-1']);
    expect(splitTags('@Иван!')).toEqual([{ text: '@Иван', tag: '@иван' }, { text: '!' }]);
  });

  it('splits text into plain and tag segments that join back to the text', () => {
    const text = '#начало и середина #Тег, конец';
    const segments = splitTags(text);
    expect(segments).toEqual([
      { text: '#начало', tag: 'начало' },
      { text: ' и середина ' },
      { text: '#Тег', tag: 'тег' },
      { text: ', конец' },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(splitTags('')).toEqual([]);
  });
});

describe('TagIndex', () => {
  const contents = (index: TagIndex) =>
    Object.fromEntries([...index.counts().keys()].sort().map((t) => [t, [...index.nodesWith(t)].sort()]));

  it('indexes the doc and follows edits, inserts and removals', () => {
    const { doc, ctx, run } = setup(['a #x', '  b #y #x', 'c']);
    const index = new TagIndex(doc);
    expect(contents(index)).toEqual({ x: ['a #x', 'b #y #x'], y: ['b #y #x'] });
    run(() => cmd.setText(ctx, 'c', 'c #X'));
    run(() => cmd.setText(ctx, 'b #y #x', 'b'));
    expect(contents(index)).toEqual({ x: ['a #x', 'c'] });
    run(() => cmd.deleteNode(ctx, 'a #x'));
    expect(contents(index)).toEqual({ x: ['c'] });
    expect(index.nodesWith('нет').size).toBe(0);
  });

  it('matches a freshly built index after random edits and undo', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx } = setup(['a #x', '  b', 'c #y', '  d #x']);
      const index = new TagIndex(doc);
      const history: Op[][] = [];
      for (let step = 0; step < 200; step++) {
        const id = pick(rows.ids);
        const n = doc.get(id);
        const action = pick([
          () => cmd.split(ctx, id, Math.floor(rand() * (n.text.length + 1))),
          () => cmd.mergeUp(ctx, id),
          () => cmd.deleteNode(ctx, id),
          () => cmd.indent(ctx, id),
          () => cmd.setText(ctx, id, n.text + pick([' #x', ' #y', ' #Z', 'q', '#'])),
          () => cmd.setText(ctx, id, n.text.slice(0, Math.floor(rand() * n.text.length))),
        ]);
        history.push(doc.transact(() => { action(); }));
        if (rand() < 0.1 && history.length) {
          const ops = history.pop()!;
          doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
        }
      }
      const fresh = new TagIndex(doc);
      fresh.dispose();
      expect(contents(index), `seed ${seed}`).toEqual(contents(fresh));
    }
  });
});

describe('notes in tags', () => {
  it('indexes tags written in a note, and follows note edits', () => {
    const { doc, ctx, run } = setup(['a']);
    const index = new TagIndex(doc);
    run(() => cmd.setNote(ctx, 'a', 'подробности #важно'));
    expect([...index.nodesWith('важно')]).toEqual(['a']);
    run(() => cmd.setNote(ctx, 'a', ''));
    expect(index.nodesWith('важно').size).toBe(0);
  });
});
