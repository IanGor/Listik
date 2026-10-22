import { describe, expect, it } from 'vitest';
import { BOLD, ITALIC, MARKER, URL, caretOutside, formatFlags, linkOver, plainText, toggleFormat, webLinks } from '../src/model/format';
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

describe('caretOutside', () => {
  it('a click on the edge of a run puts the caret outside its markers', () => {
    // [text, where the browser put the caret, where it goes]
    const cases: [string, number, number][] = [
      ['a **b**', 5, 7],
      ['a **b**', 4, 2],
      ['**b** c', 3, 5],
      ['**b** c', 2, 0],
      ['a *i* c', 4, 5],
      ['a *i* c', 3, 2],
      ['a _i_ c', 4, 5],
      ['a _i_ c', 3, 2],
      ['***b***', 4, 7],
      ['***b***', 3, 0],
      ['see [[Page]]', 10, 12],
      ['see [[Page]]', 6, 4],
      ['**https://x.ru**', 14, 16],
    ];
    for (const [text, at, to] of cases) expect([text, at, caretOutside(text, at)]).toEqual([text, at, to]);
  });

  it('italic inside bold: out of the italic, still in the bold', () => {
    expect(caretOutside('**a *b***', 6)).toBe(9);
    expect(caretOutside('**a *b***', 5)).toBe(4);
  });

  it('elsewhere the caret stays', () => {
    expect(caretOutside('plain', 2)).toBe(2);
    expect(caretOutside('a **bc** d', 5)).toBe(5);
    expect(caretOutside('a **b** c', 1)).toBe(1);
    // Between two runs either side is inside one of them.
    expect(caretOutside('**a**_b_', 3)).toBe(3);
    expect(caretOutside('**a**_b_', 6)).toBe(6);
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

describe('Markdown links [words](address)', () => {
  it('the words lead to the address; brackets and address are hidden markers', () => {
    const text = 'см. [Яндекс](https://ya.ru) тут';
    expect(webLinks(text)).toEqual([{ start: 4, end: 27, href: 'https://ya.ru', label: { start: 5, end: 11 } }]);
    expect(plainText(text)).toBe('см. Яндекс тут');
    const pieces = decorate(text, []);
    expect(pieces.filter((p) => p.url && !p.marker)).toEqual([{ text: 'Яндекс', url: 'https://ya.ru' }]);
    expect(pieces.filter((p) => p.marker).map((p) => p.text)).toEqual(['[', '](https://ya.ru)']);
    expect(webLinks('[сайт](www.x.org)')[0].href).toBe('https://www.x.org');
  });

  it('a bare address and a Markdown link side by side; the address inside is not a second link', () => {
    const text = 'https://a.ru и [б](https://b.ru)';
    expect(webLinks(text).map((w) => [text.slice(w.start, w.end), w.href])).toEqual([
      ['https://a.ru', 'https://a.ru'],
      ['[б](https://b.ru)', 'https://b.ru'],
    ]);
  });

  it('the other way round, (words)[address], or spaces in the address, are not links; [[links]] stay theirs', () => {
    expect(webLinks('(Яндекс)[https://ya.ru]').map((w) => w.href)).toEqual(['https://ya.ru']);
    expect(webLinks('(Яндекс)[https://ya.ru]')[0].label).toBeUndefined();
    expect(webLinks('[а](https://ya .ru)').every((w) => !w.label)).toBe(true);
    expect(webLinks('[[Пьер]](https://ya.ru)').every((w) => !w.label)).toBe(true);
  });

  it('bold and italic inside the words, and around the whole link', () => {
    const tail = '](https://x.ru)'.length;
    expect(show('[**жир**](https://x.ru)')).toBe('mmm' + 'bbb' + 'm'.repeat(2 + tail));
    expect(show('**[жир](https://x.ru)**')).toBe('mmm' + 'bbb' + 'm'.repeat(tail + 2));
    expect(show('*[к](https://x.ru)*')).toBe('mm' + 'i' + 'm'.repeat(tail + 1));
  });

  it('a click by its edge puts the caret outside it', () => {
    const text = 'а [б](https://x.ru)';
    expect(caretOutside(text, 4)).toBe(text.length);
    expect(caretOutside(text, 3)).toBe(2);
  });

  it('an address pasted over words makes them its link', () => {
    expect(linkOver('открыть ссылка тут', 8, 14, 'https://ya.ru')).toBe('[ссылка](https://ya.ru)');
    // Spaces at the selection's edges stay outside; the pasted address is trimmed.
    expect(linkOver('a слово b', 1, 8, ' https://ya.ru\n')).toBe(' [слово](https://ya.ru) ');
    // Parentheses in the address are escaped, so the link still reads as one.
    expect(linkOver('вики', 0, 4, 'https://x.org/A_(b)')).toBe('[вики](https://x.org/A_%28b%29)');
    expect(webLinks('[вики](https://x.org/A_%28b%29)')[0].label).toEqual({ start: 1, end: 5 });
    // Not an address, nothing selected, or words a link cannot hold: an ordinary paste.
    expect(linkOver('слово', 0, 5, 'просто текст')).toBeNull();
    expect(linkOver('слово', 0, 5, 'https://a.ru https://b.ru')).toBeNull();
    expect(linkOver('слово', 2, 2, 'https://ya.ru')).toBeNull();
    expect(linkOver('   ', 0, 3, 'https://ya.ru')).toBeNull();
    expect(linkOver('[[Пьер]]', 0, 8, 'https://ya.ru')).toBeNull();
  });
});
