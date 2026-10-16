// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { looksLikeOpml, parseIndented, parseOpml, toMarkdown, toOpml, type Tree } from '../src/model/outline-text';
import { build, dump, setup } from './helpers';

const outline = (trees: Tree[], depth = 0): string[] =>
  trees.flatMap((t) => ['  '.repeat(depth) + t.text, ...outline(t.children, depth + 1)]);

describe('parseIndented', () => {
  it('reads Markdown lists, any indent unit, and drops markers and heading marks', () => {
    // Nesting comes from indentation only: a heading is a bullet like any other.
    const md = '# Том первый\n\n- Часть первая\n    1. глава\n    2) ещё\n\t- в табах\n* #тег остаётся\n+ плюс\n• точка\n';
    expect(outline(parseIndented(md))).toEqual([
      'Том первый',
      'Часть первая',
      '  глава',
      '  ещё',
      '  в табах',
      '#тег остаётся',
      'плюс',
      'точка',
    ]);
  });

  it('nests by relative indentation, even when it is uneven', () => {
    expect(outline(parseIndented('a\n   b\n      c\n   d\n e\nf'))).toEqual(['a', '  b', '    c', '  d', '  e', 'f']);
  });
});

describe('Markdown and OPML', () => {
  const lines = ['Война & мир <1869>', '  "Анна" Павловна #салон', '    глубже', 'Том второй'];

  it('round-trips through Markdown', () => {
    const doc = build(lines);
    expect(outline(parseIndented(toMarkdown(doc)))).toEqual(lines);
  });

  it('round-trips through OPML, escaping XML', () => {
    const doc = build(lines);
    const xml = toOpml(doc);
    expect(xml).toContain('text="Война &amp; мир &lt;1869&gt;"');
    expect(looksLikeOpml(xml)).toBe(true);
    expect(looksLikeOpml('- просто список')).toBe(false);
    expect(outline(parseOpml(xml))).toEqual(lines);
  });

  it('rejects something that is not OPML', () => {
    expect(() => parseOpml('<html><body>нет</body></html>')).toThrow(/OPML/);
  });
});

describe('insertTrees / appendTrees', () => {
  it('pastes a tree: first line at the caret, its children first, the rest below with the tail text', () => {
    const { doc, ctx, run } = setup(['abXY', '  old', 'next']);
    const focus = run(() => cmd.insertTrees(ctx, 'abXY', 2, 2, parseIndented('1\n  1.1\n2\n  2.1\n    2.1.1')));
    expect(dump(doc)).toEqual(['ab1', '  1.1', '  old', '2XY', '  2.1', '    2.1.1', 'next']);
    expect(doc.get(focus.id).text).toBe('2XY');
    expect(focus.caret).toBe(1);
    checkInvariants(doc);
  });

  it('imports trees as the last children of a bullet, as one undoable step', () => {
    const { doc, ctx } = setup(['a', '  b']);
    const ops = doc.transact(() => { cmd.appendTrees(ctx, 'a', parseIndented('x\n  y\nz')); });
    expect(dump(doc)).toEqual(['a', '  b', '  x', '    y', '  z']);
    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dump(doc)).toEqual(['a', '  b']);
  });
});
