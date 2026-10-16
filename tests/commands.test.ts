import { describe, expect, it } from 'vitest';
import {
  deleteNode, indent, insertText, mergeUp, moveDown, moveUp, outdent, setCollapsed, split,
} from '../src/model/commands';
import { checkInvariants } from '../src/model/invariants';
import { dump, dumpRows, setup } from './helpers';

describe('split (Enter)', () => {
  it('splits the text at the caret into a new sibling below', () => {
    const { doc, ctx, run } = setup(['helloworld', 'next']);
    const focus = run(() => split(ctx, 'helloworld', 5));
    expect(dump(doc)).toEqual(['hello', 'world', 'next']);
    expect(doc.get(focus.id).text).toBe('world');
    expect(focus.caret).toBe(0);
  });

  it('at the start of a non-empty bullet inserts an empty bullet above', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    const focus = run(() => split(ctx, 'b', 0));
    expect(dump(doc)).toEqual(['a', '', 'b']);
    expect(focus).toEqual({ id: 'b', caret: 0 });
  });

  it('on a bullet with expanded children creates the first child', () => {
    const { doc, ctx, run } = setup(['parent', '  kid']);
    const focus = run(() => split(ctx, 'parent', 6));
    expect(dump(doc)).toEqual(['parent', '  ', '  kid']);
    expect(doc.get(focus.id).parent).toBe('parent');
  });

  it('on a collapsed bullet creates a sibling and keeps the children', () => {
    const { doc, ctx, run } = setup(['parent [+]', '  kid']);
    run(() => split(ctx, 'parent', 6));
    expect(dump(doc)).toEqual(['parent [+]', '  kid', '']);
  });
});

describe('insertText (paste)', () => {
  it('inserts a single line at the caret, replacing the selection', () => {
    const { doc, ctx, run } = setup(['hello world']);
    const focus = run(() => insertText(ctx, 'hello world', 6, 11, ['there']));
    expect(dump(doc)).toEqual(['hello there']);
    expect(focus).toEqual({ id: 'hello world', caret: 11 });
  });

  it('turns extra lines into bullets and moves the tail to the last one', () => {
    const { doc, ctx, run } = setup(['abXY', 'next']);
    const focus = run(() => insertText(ctx, 'abXY', 2, 2, ['1', '2', '3']));
    expect(dump(doc)).toEqual(['ab1', '2', '3XY', 'next']);
    expect(doc.get(focus.id).text).toBe('3XY');
    expect(focus.caret).toBe(1);
  });
});

describe('mergeUp (Backspace at start)', () => {
  it('removes an empty bullet and puts the caret at the end of the previous row', () => {
    const { doc, ctx, run } = setup(['abc', 'empty']);
    run(() => ctx.doc.apply({ t: 'setText', id: 'empty', from: 'empty', to: '' }));
    const focus = run(() => mergeUp(ctx, 'empty'));
    expect(dump(doc)).toEqual(['abc']);
    expect(focus).toEqual({ id: 'abc', caret: 3 });
  });

  it('appends the text to the previous visible row, even across levels', () => {
    const { doc, ctx, run } = setup(['a', '  deep', 'tail']);
    const focus = run(() => mergeUp(ctx, 'tail'));
    expect(dump(doc)).toEqual(['a', '  deeptail']);
    expect(focus).toEqual({ id: 'deep', caret: 4 });
  });

  it('does nothing on the first row or on a bullet with children', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  c']);
    expect(run(() => mergeUp(ctx, 'a'))).toBeUndefined();
    expect(run(() => mergeUp(ctx, 'b'))).toBeUndefined();
    expect(dump(doc)).toEqual(['a', 'b', '  c']);
  });
});

describe('deleteNode', () => {
  it('removes the subtree and focuses the previous row', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  c', 'd']);
    const focus = run(() => deleteNode(ctx, 'b'));
    expect(dump(doc)).toEqual(['a', 'd']);
    expect(focus).toEqual({ id: 'a', caret: 1 });
  });

  it('focuses the next row when deleting the first one', () => {
    const { ctx, run } = setup(['a', 'b']);
    expect(run(() => deleteNode(ctx, 'a'))).toEqual({ id: 'b', caret: 0 });
  });

  it('never leaves the outline empty', () => {
    const { doc, ctx, run } = setup(['only']);
    const focus = run(() => deleteNode(ctx, 'only'))!;
    expect(dump(doc)).toEqual(['']);
    expect(doc.has(focus.id)).toBe(true);
  });
});

describe('indent / outdent', () => {
  it('indent makes the bullet the last child of its previous sibling', () => {
    const { doc, ctx, run } = setup(['a', '  x', 'b']);
    run(() => indent(ctx, 'b'));
    expect(dump(doc)).toEqual(['a', '  x', '  b']);
  });

  it('indent expands a collapsed new parent', () => {
    const { doc, ctx, run } = setup(['a [+]', '  x', 'b']);
    run(() => indent(ctx, 'b'));
    expect(dump(doc)).toEqual(['a', '  x', '  b']);
  });

  it('indent of a first child does nothing', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => indent(ctx, 'a'));
    expect(dump(doc)).toEqual(['a', 'b']);
  });

  it('outdent makes the bullet the next sibling of its parent; later siblings stay', () => {
    const { doc, ctx, run } = setup(['p', '  a', '  b', '  c', 'q']);
    run(() => outdent(ctx, 'b'));
    expect(dump(doc)).toEqual(['p', '  a', '  c', 'b', 'q']);
  });

  it('outdent of a top-level bullet does nothing', () => {
    const { doc, ctx, run } = setup(['a']);
    run(() => outdent(ctx, 'a'));
    expect(dump(doc)).toEqual(['a']);
  });
});

describe('moveUp / moveDown', () => {
  it('swaps with siblings, carrying the subtree', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  b1', 'c']);
    run(() => moveUp(ctx, 'b'));
    expect(dump(doc)).toEqual(['b', '  b1', 'a', 'c']);
    run(() => moveDown(ctx, 'b'));
    run(() => moveDown(ctx, 'b'));
    expect(dump(doc)).toEqual(['a', 'c', 'b', '  b1']);
  });

  it('crosses into the neighbouring parent at the edges', () => {
    const { doc, ctx, run } = setup(['p', '  x', '  y', 'q [+]', '  z']);
    run(() => moveDown(ctx, 'y'));
    expect(dump(doc)).toEqual(['p', '  x', 'q', '  y', '  z']);
    run(() => moveUp(ctx, 'y'));
    expect(dump(doc)).toEqual(['p', '  x', '  y', 'q', '  z']);
  });

  it('does nothing at the very top or bottom', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => moveUp(ctx, 'a'));
    run(() => moveDown(ctx, 'b'));
    expect(dump(doc)).toEqual(['a', 'b']);
  });
});

describe('setCollapsed', () => {
  it('hides and shows children in the visible rows', () => {
    const { doc, rows, ctx, run } = setup(['a', '  b', '    c', 'd']);
    run(() => setCollapsed(ctx, 'a', true));
    expect(dumpRows(rows, doc)).toEqual(['a [+]', 'd']);
    run(() => setCollapsed(ctx, 'a', false));
    expect(dumpRows(rows, doc)).toEqual(['a', '  b', '    c', 'd']);
    checkInvariants(doc);
  });

  it('ignores bullets without children', () => {
    const { doc, ctx, run } = setup(['a']);
    run(() => setCollapsed(ctx, 'a', true));
    expect(dump(doc)).toEqual(['a']);
  });
});
