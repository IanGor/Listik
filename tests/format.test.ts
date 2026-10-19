import { describe, expect, it } from 'vitest';
import { BOLD, ITALIC, MARKER, URL, formatFlags, plainText, toggleFormat, webLinks } from '../src/model/format';
import { decorate } from '../src/model/search';

/** Flags as a string: b bold, i italic, B bold+italic, m marker, . plain. */
function show(text: string): string {
  const f = formatFlags(text);
  if (!f) return '.'.repeat(text.length);
  return [...f].map((x) => (x & MARKER ? 'm' : x === (BOLD | ITALIC) ? 'B' : x & BOLD ? 'b' : x & ITALIC ? 'i' : '.')).join('');
}

describe('formatFlags', () => {
  it('finds **bold**, *italic* and _italic_, markers apart', () => {
    expect(show('**Жирное**')).toBe('mmbbbbbbmm');
    expect(show('a *курсив* b')).toBe('..miiiiiim..');
    expect(show('_тоже_')).toBe('miiiim');
    expect(show('**жир и *наклон* тут**')).toBe('mmbbbbbbmBBBBBBmbbbbmm');
    expect(show('***оба***')).toBe('mmmBBBmmm');
    expect(show('**а *б***')).toBe('mmbbmBmmm');
    expect(show('*а **б** в*')).toBe('miimmBmmiim');
    // Offsets are UTF-16, as everywhere in the model: an emoji takes two.
    expect(show('🙂 **да**')).toBe('...mmbbmm');
  });

  it('leaves arithmetic, snake_case, lone and spaced markers alone', () => {
    expect(formatFlags('просто текст')).toBeNull();
    expect(show('2*3*4')).toBe('.....');
    expect(show('snake_case_name')).toBe('...............');
    expect(show('a * b * c')).toBe('.........');
    expect(show('** не жирное**')).toBe('..............');
    expect(show('****')).toBe('....');
  });
});

describe('plainText', () => {
  it('drops the markers', () => {
    expect(plainText('**Глава** _первая_')).toBe('Глава первая');
    expect(plainText('2*3*4')).toBe('2*3*4');
  });
});

describe('toggleFormat', () => {
  it('wraps a selection, or an empty one, and unwraps it again', () => {
    expect(toggleFormat('a word b', 2, 6, '**')).toEqual({ text: 'a **word** b', start: 4, end: 8 });
    expect(toggleFormat('a **word** b', 4, 8, '**')).toEqual({ text: 'a word b', start: 2, end: 6 });
    expect(toggleFormat('ab', 1, 1, '*')).toEqual({ text: 'a**b', start: 2, end: 2 });
    expect(toggleFormat('a *word* b', 3, 7, '*')).toEqual({ text: 'a word b', start: 2, end: 6 });
  });

  it('italic inside bold adds a marker rather than eating the bold one', () => {
    expect(toggleFormat('**word**', 2, 6, '*')).toEqual({ text: '***word***', start: 3, end: 7 });
    expect(toggleFormat('***word***', 3, 7, '*')).toEqual({ text: '**word**', start: 2, end: 6 });
    expect(toggleFormat('***word***', 3, 7, '**')).toEqual({ text: '*word*', start: 1, end: 5 });
  });
});

describe('web addresses', () => {
  const found = (text: string) => webLinks(text).map((w) => [text.slice(w.start, w.end), w.href]);

  it('finds http, https and www addresses, leaving out what ends the sentence', () => {
    expect(found('см. https://example.com/a?b=1#c, и www.site.ru.')).toEqual([
      ['https://example.com/a?b=1#c', 'https://example.com/a?b=1#c'],
      ['www.site.ru', 'https://www.site.ru'],
    ]);
    expect(found('(подробно: http://x.org/wiki/A_(b))')).toEqual([['http://x.org/wiki/A_(b)', 'http://x.org/wiki/A_(b)']]);
    expect(found('(http://x.org)')).toEqual([['http://x.org', 'http://x.org']]);
    expect(found('«https://ya.ru»')).toEqual([['https://ya.ru', 'https://ya.ru']]);
    expect(found('https:// and www. alone, a@b.ru, nothing')).toEqual([]);
  });

  it('inside an address, _ and * are not markers, yet bold may hold a whole address', () => {
    const text = 'https://x.org/a_b_c and _it_';
    const f = formatFlags(text)!;
    expect(f[15] & URL).toBe(URL);
    expect(f[15] & ITALIC).toBe(0);
    expect(f[text.indexOf('it')] & ITALIC).toBe(ITALIC);
    const bold = formatFlags('**see https://x.org**')!;
    expect(bold[8] & BOLD).toBe(BOLD);
    expect(bold[8] & URL).toBe(URL);
    expect(bold[0] & MARKER).toBe(MARKER);
  });

  it('decorates an address as a piece that leads to it; a link keeps its own', () => {
    const pieces = decorate('читать https://x.org/a_b #тег', []);
    expect(pieces.filter((p) => p.url)).toEqual([{ text: 'https://x.org/a_b', url: 'https://x.org/a_b' }]);
    expect(pieces.find((p) => p.tag)?.tag).toBe('тег');
    expect(decorate('[[Пьер]]', []).some((p) => p.url)).toBe(false);
  });
});
