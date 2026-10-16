import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { TextIndex, decorate, findMatches, normalize, parseQuery } from '../src/model/search';
import { TagIndex } from '../src/model/tags';
import { rng, setup } from './helpers';

describe('normalize', () => {
  it('ignores case and ё, keeping the length', () => {
    expect(normalize('Ёлка ПЬЕР Елена')).toBe('елка пьер елена');
    const odd = 'İstanbul';
    expect(normalize(odd)).toHaveLength(odd.length);
  });
});

describe('parseQuery', () => {
  it('splits words, "phrases" and #tags', () => {
    expect(parseQuery('Пьер "Анна Павловна" #Салон  #война-и-мир')).toEqual({
      tags: ['салон', 'война-и-мир'],
      terms: ['пьер', 'анна павловна'],
    });
  });

  it('treats a bare # or a broken tag as text and drops stray quotes and duplicates', () => {
    expect(parseQuery('# #- "" "незакрытая фраза пьер Пьер')).toEqual({
      tags: [],
      terms: ['#', '#-', 'незакрытая', 'фраза', 'пьер'],
    });
    expect(parseQuery('   ')).toEqual({ tags: [], terms: [] });
  });
});

describe('findMatches', () => {
  const lines = ['Князь Андрей #война', '  Пьер на балу #бал', '  Пьер и Андрей #война #бал', 'Ёлка у Ростовых'];
  const env = () => {
    const e = setup(lines);
    return { ...e, tags: new TagIndex(e.doc), text: new TextIndex(e.doc) };
  };
  const find = (q: string) => {
    const { tags, text } = env();
    return [...findMatches(parseQuery(q), tags, text)].sort();
  };

  it('needs every word in the same bullet, in any case and with ё = е', () => {
    expect(find('пьер андрей')).toEqual(['Пьер и Андрей #война #бал']);
    expect(find('елка')).toEqual(['Ёлка у Ростовых']);
    expect(find('князь пьер')).toEqual([]);
  });

  it('matches phrases as a whole and combines tags with words', () => {
    expect(find('"пьер на"')).toEqual(['Пьер на балу #бал']);
    expect(find('#бал #война')).toEqual(['Пьер и Андрей #война #бал']);
    expect(find('#война князь')).toEqual(['Князь Андрей #война']);
    expect(find('#нет')).toEqual([]);
  });

  it('follows edits and stays equal to a freshly built index', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx, text } = env();
      text.warmUp(); // so edits go through the incremental path
      for (let step = 0; step < 200; step++) {
        const id = pick(rows.ids);
        const n = doc.get(id);
        const action = pick([
          () => cmd.split(ctx, id, Math.floor(rand() * (n.text.length + 1))),
          () => cmd.mergeUp(ctx, id),
          () => cmd.deleteNode(ctx, id),
          () => cmd.setText(ctx, id, n.text + pick([' Пьер', ' ёж', 'Ж', ' война'])),
        ]);
        doc.transact(() => { action(); });
      }
      const fresh = new TextIndex(doc);
      fresh.dispose();
      for (const q of [['пьер'], ['еж'], ['война', 'пьер'], ['ж']]) {
        expect([...text.find(q)].sort(), `seed ${seed} ${q}`).toEqual([...fresh.find(q)].sort());
      }
    }
  });
});

describe('TextIndex', () => {
  it('is built lazily, from the doc as it is at the first search', () => {
    const { doc, ctx, run } = setup(['до']);
    const text = new TextIndex(doc);
    run(() => cmd.setText(ctx, 'до', 'после'));
    expect([...text.find(['после'])]).toEqual(['до']);
    expect(text.find(['до']).size).toBe(0);
  });

  it('stays correct when edits arrive in the middle of an idle build', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `строка ${i}`);
    const { doc, ctx, run } = setup(lines);
    const text = new TextIndex(doc);
    let budget = 1;
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (fn: (d: IdleDeadline) => void) =>
      budget-- > 0 && fn({ timeRemaining: () => 0, didTimeout: false } as IdleDeadline);
    try {
      text.warmUpInIdle(); // starts the build, normalizes nothing (no time left), stops
    } finally {
      delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    }
    run(() => cmd.setText(ctx, 'строка 0', 'Новая'));
    run(() => cmd.setText(ctx, 'строка 2999', 'тоже новая'));
    run(() => cmd.deleteNode(ctx, 'строка 1'));
    expect([...text.find(['новая'])].sort()).toEqual(['строка 0', 'строка 2999']);
    expect(text.find(['строка']).size).toBe(2997);
  });
});

describe('decorate', () => {
  it('marks every hit, inside and outside tags, and joins back to the text', () => {
    const text = 'Пьер, пьер и #пьер-безухов';
    const pieces = decorate(text, ['пьер']);
    expect(pieces).toEqual([
      { text: 'Пьер', hit: true },
      { text: ', ' },
      { text: 'пьер', hit: true },
      { text: ' и ' },
      { text: '#', tag: 'пьер-безухов' },
      { text: 'пьер', tag: 'пьер-безухов', hit: true },
      { text: '-безухов', tag: 'пьер-безухов' },
    ]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
  });

  it('merges overlapping hits and leaves text without hits alone', () => {
    expect(decorate('Наташа', ['наташ', 'таша'])).toEqual([{ text: 'Наташа', hit: true }]);
    expect(decorate('Ёлка', ['елк'])).toEqual([{ text: 'Ёлк', hit: true }, { text: 'а' }]);
    expect(decorate('без совпадений', ['пьер'])).toEqual([{ text: 'без совпадений' }]);
  });
});
