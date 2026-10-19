import { describe, expect, it } from 'vitest';
import { tokenBefore } from '../src/model/complete';
import type { Doc } from '../src/model/doc';
import { plainText } from '../src/model/format';
import { closesLink, compareOrder, findTargets, linkBefore, opensLink, resolveLink, titleOf } from '../src/model/links';
import { TextIndex, decorate } from '../src/model/search';
import type { NodeId } from '../src/model/types';
import { build } from './helpers';

/** Adds a bullet with its own id, for titles that repeat. */
function add(doc: Doc, parent: NodeId, id: NodeId, text: string, updated = 0): void {
  doc.apply({
    t: 'insert',
    parent,
    node: {
      id, order: doc.orderAt(parent, doc.get(parent).children.length), text, note: '', collapsed: false,
      todo: false, done: false, created: 0, updated, children: [],
    },
  });
}

describe('titleOf', () => {
  it('drops bold and italic markers but keeps link brackets', () => {
    expect(titleOf('  **Война** и *мир* ')).toBe('Война и мир');
    expect(titleOf('см. [[Пьер]]')).toBe('см. [[Пьер]]');
    expect(plainText('см. [[Пьер]]')).toBe('см. Пьер');
  });
});

describe('linkBefore', () => {
  it('finds the link the caret is in, through its closing brackets', () => {
    expect(linkBefore('[[]]', 2)).toEqual({ start: 0, end: 4, query: '' });
    expect(linkBefore('см. [[Пье]] и', 9)).toEqual({ start: 4, end: 11, query: 'Пье' });
    expect(linkBefore('см. [[Пьер Безухов]]', 9)).toEqual({ start: 4, end: 20, query: 'Пье' });
    expect(linkBefore('[[Пье', 5)).toEqual({ start: 0, end: 5, query: 'Пье' });
  });

  it('ends at a bracket or a line break', () => {
    expect(linkBefore('[[a]] b', 7)).toBeNull();
    expect(linkBefore('[a', 2)).toBeNull();
    expect(linkBefore('[[a\nb', 5)).toBeNull();
    expect(linkBefore('текст', 5)).toBeNull();
  });

  it('wins over a tag inside the link', () => {
    expect(tokenBefore('[[#сал', 6)).toEqual({ kind: '[[', start: 0, end: 6, query: '#сал' });
  });
});

describe('opensLink / closesLink', () => {
  it('closes "[[" once, not inside "[[[" or before "]]"', () => {
    expect(opensLink('[[', 2)).toBe(true);
    expect(opensLink('a [[b', 4)).toBe(true);
    expect(opensLink('[[[', 3)).toBe(false);
    expect(opensLink('[[]]', 2)).toBe(false);
    expect(opensLink('[', 1)).toBe(false);
  });

  it('steps over the closing brackets of a link being typed', () => {
    expect(closesLink('[[a]]', 3)).toBe(true);
    expect(closesLink('[[a]]', 4)).toBe(true);
    expect(closesLink('[[a]]', 5)).toBe(false);
    expect(closesLink('a]]', 1)).toBe(false);
    expect(closesLink('[a]', 2)).toBe(false);
  });
});

describe('decorate with links', () => {
  it('hides the brackets and gives the title to the rest, tags inside it included', () => {
    const text = 'см. [[Пьер #герой]] и #салон';
    const pieces = decorate(text, []);
    expect(pieces).toEqual([
      { text: 'см. ' },
      { text: '[[', marker: true, link: 'Пьер #герой' },
      { text: 'Пьер ', link: 'Пьер #герой' },
      { text: '#герой', link: 'Пьер #герой' },
      { text: ']]', marker: true, link: 'Пьер #герой' },
      { text: ' и ' },
      { text: '#салон', tag: 'салон' },
    ]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
  });

  it('keeps search hits and formatting inside a link', () => {
    expect(decorate('[[**Пьер**]] [[Анна]]', ['пьер'])).toEqual([
      { text: '[[**', marker: true, link: '**Пьер**' },
      { text: 'Пьер', link: '**Пьер**', hit: true, bold: true },
      { text: '**]]', marker: true, link: '**Пьер**' },
      { text: ' ' },
      { text: '[[', marker: true, link: 'Анна' },
      { text: 'Анна', link: 'Анна' },
      { text: ']]', marker: true, link: 'Анна' },
    ]);
  });

  it('leaves blank or broken brackets as text', () => {
    expect(decorate('[[ ]] [[a] [b]]', [])).toEqual([{ text: '[[ ]] [[a] [b]]' }]);
  });
});

describe('resolveLink', () => {
  it('finds the bullet by title: any case, ё = е, formatting aside', () => {
    const doc = build(['Книги', '  **Война** и мир', '  Ёлка', 'см. [[Ёлка]]']);
    const index = new TextIndex(doc);
    expect(resolveLink(doc, index, 'война И МИР')).toBe('  **Война** и мир'.trim());
    expect(resolveLink(doc, index, ' елка ')).toBe('Ёлка');
    expect(resolveLink(doc, index, 'Нет такого')).toBeNull();
    expect(resolveLink(doc, index, '')).toBeNull();
  });

  it('takes the first in document order when titles repeat, never one in the trash', () => {
    const doc = build(['A', '  B', 'C']);
    add(doc, 'C', 'late', 'Идеи');
    add(doc, 'B', 'early', 'Идеи');
    add(doc, doc.root, 'last', 'Идеи');
    const index = new TextIndex(doc);
    expect(resolveLink(doc, index, 'идеи')).toBe('early');
    doc.apply({ t: 'move', id: 'early', from: { parent: 'B', order: doc.get('early').order }, to: { parent: 'trash', order: 'a0' } });
    expect(resolveLink(doc, index, 'идеи')).toBe('late');
  });
});

describe('compareOrder', () => {
  it('orders bullets as the outline reads, an ancestor before its descendants', () => {
    const doc = build(['A', '  B', '    C', '  D', 'E']);
    expect(compareOrder(doc, 'A', 'C')).toBe(-1);
    expect(compareOrder(doc, 'C', 'D')).toBe(-1);
    expect(compareOrder(doc, 'E', 'B')).toBe(1);
    expect(compareOrder(doc, 'D', 'D')).toBe(0);
  });
});

describe('findTargets', () => {
  const titles = (doc: Doc, query: string, self = '', limit = 8) =>
    findTargets(doc, new TextIndex(doc), query, self, limit).map((t) => t.title);

  it('puts titles that start with the query first, then word starts, then the rest; shorter first', () => {
    const doc = build(['Пьер Безухов', 'Пьер', 'Граф Пьер', 'Спьеро', 'Анна']);
    expect(titles(doc, 'пьер')).toEqual(['Пьер', 'Пьер Безухов', 'Граф Пьер', 'Спьеро']);
    expect(titles(doc, 'пьер', '', 2)).toEqual(['Пьер', 'Пьер Безухов']);
  });

  it('leaves out the bullet being edited, blank ones and those with brackets', () => {
    const doc = build(['Пьер [[Анна]]', 'Пьер и [[Пье']);
    add(doc, doc.root, 'blank', '   ');
    add(doc, doc.root, 'p', '**Пьер**');
    expect(titles(doc, 'пье', 'Пьер и [[Пье')).toEqual(['Пьер']);
    expect(titles(doc, 'пьер пье')).toEqual([]);
  });

  it('offers a repeated title once, where the link really goes, with its parent as the hint', () => {
    const doc = build(['Проект А', 'Проект Б']);
    add(doc, 'Проект Б', 'b', 'Идеи', 5);
    add(doc, 'Проект А', 'a', 'Идеи', 1);
    expect(findTargets(doc, new TextIndex(doc), 'иде', '', 8)).toEqual([{ id: 'a', title: 'Идеи', where: 'Проект А' }]);
  });

  it('offers the bullets edited last when nothing is typed', () => {
    const doc = build([]);
    add(doc, doc.root, 'old', 'Старый', 1);
    add(doc, doc.root, 'new', 'Новый', 3);
    add(doc, doc.root, 'mid', 'Средний', 2);
    add(doc, doc.root, 'dup', 'Новый', 0);
    expect(titles(doc, '', '', 2)).toEqual(['Новый', 'Средний']);
    expect(titles(doc, '  ')).toEqual(['Новый', 'Средний', 'Старый']);
  });
});
