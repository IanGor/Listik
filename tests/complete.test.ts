import { describe, expect, it } from 'vitest';
import { matchCommands, matchTags, suggestLimit, tokenBefore } from '../src/model/complete';

describe('tokenBefore', () => {
  it('finds a /command or #tag being typed before the caret', () => {
    expect(tokenBefore('/', 1)).toEqual({ kind: '/', query: '', start: 0, end: 1 });
    expect(tokenBefore('встреча /ti', 11)).toEqual({ kind: '/', query: 'ti', start: 8, end: 11 });
    expect(tokenBefore('план #', 6)).toEqual({ kind: '#', query: '', start: 5, end: 6 });
    expect(tokenBefore('(#война-и', 9)).toEqual({ kind: '#', query: 'война-и', start: 1, end: 9 });
  });

  it('spans the whole word when the caret is inside it', () => {
    expect(tokenBefore('#сал и', 3)).toEqual({ kind: '#', query: 'са', start: 0, end: 4 });
  });

  it('needs the sigil to stand on its own', () => {
    expect(tokenBefore('a/ti', 4)).toBeNull();
    expect(tokenBefore('https://x.ru/time', 17)).toBeNull();
    expect(tokenBefore('a#b', 3)).toBeNull();
    expect(tokenBefore('(/ti', 4)).toBeNull();
    expect(tokenBefore('#тег ', 5)).toBeNull();
    expect(tokenBefore('слово', 5)).toBeNull();
    expect(tokenBefore('', 0)).toBeNull();
  });
});

describe('matchCommands', () => {
  it('filters by the start of the name, any case', () => {
    expect(matchCommands('').map((c) => c.name)).toEqual(['time']);
    expect(matchCommands('TI').map((c) => c.name)).toEqual(['time']);
    expect(matchCommands('x')).toEqual([]);
  });
});

describe('matchTags', () => {
  const tags: [string, number][] = [['салон', 3], ['шерер', 1], ['сад', 5], ['война-и-мир', 2], ['мир', 1]];

  it('puts prefixes first, then inner matches; frequent first within each', () => {
    expect(matchTags(tags, 'са', 8)).toEqual(['сад', 'салон']);
    expect(matchTags(tags, 'мир', 8)).toEqual(['мир', 'война-и-мир']);
    expect(matchTags(tags, 'МИР', 8)).toEqual(['мир', 'война-и-мир']);
  });

  it('offers every tag for an empty query, up to the limit, leaving out the one being typed', () => {
    expect(matchTags(tags, '', 3)).toEqual(['сад', 'салон', 'война-и-мир']);
    expect(matchTags([['шер', 0], ['шерер', 1]], 'шер', 8)).toEqual(['шерер']);
  });
});

describe('suggestLimit', () => {
  it('fits about a third of the window: fewer on a phone with its keyboard up', () => {
    expect(suggestLimit(1080, 32)).toBe(8);
    expect(suggestLimit(540, 40)).toBe(4);
    expect(suggestLimit(300, 40)).toBe(3);
  });
});
