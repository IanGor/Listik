import { describe, expect, it } from 'vitest';
import {
  collapseChildren, deleteNode, indent, insertText, mergeUp, moveDown, moveUp, outdent, setCollapsed, setNote, split,
  toggleDone,
} from '../src/model/commands';
import * as cmd from '../src/model/commands';
import { checkInvariants } from '../src/model/invariants';
import { markdownOf, parseIndented } from '../src/model/outline-text';
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

  it('does nothing on a first row with text or on a bullet with children', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  c']);
    expect(run(() => mergeUp(ctx, 'a'))).toBeUndefined();
    expect(run(() => mergeUp(ctx, 'b'))).toBeUndefined();
    expect(dump(doc)).toEqual(['a', 'b', '  c']);
  });

  it('takes out an empty first row, under a zoom too; the caret goes to the next; never the last bullet of all', () => {
    const { doc, ctx, rows, run } = setup(['p', '  e', '  f', 'q']);
    run(() => doc.apply({ t: 'setText', id: 'e', from: 'e', to: '' }));
    rows.setTop('p');
    expect(run(() => mergeUp(ctx, 'e'))).toEqual({ id: 'f', caret: 0 });
    expect(dump(doc)).toEqual(['p', '  f', 'q']);
    const only = setup(['x']);
    only.run(() => only.doc.apply({ t: 'setText', id: 'x', from: 'x', to: '' }));
    expect(only.run(() => mergeUp(only.ctx, 'x'))).toBeUndefined();
    expect(only.doc.get(only.doc.root).children).toEqual(['x']);
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

describe('collapseChildren (the logo)', () => {
  it('folds the top-level bullets that have children, and nothing deeper', () => {
    const { doc, rows, ctx, run } = setup(['a', '  b', '    c', 'd', 'e [+]', '  f']);
    run(() => collapseChildren(ctx, doc.root));
    expect(dumpRows(rows, doc)).toEqual(['a [+]', 'd', 'e [+]']);
    expect(doc.get('b').collapsed).toBe(false);
  });
});

describe('toggleDone and notes', () => {
  it('completes all, or un-completes all when they are all done already', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => toggleDone(ctx, ['a']));
    run(() => toggleDone(ctx, ['a', 'b']));
    expect([doc.get('a').done, doc.get('b').done]).toEqual([true, true]);
    run(() => toggleDone(ctx, ['a', 'b']));
    expect([doc.get('a').done, doc.get('b').done]).toEqual([false, false]);
  });

  it('Backspace does not merge away a bullet with a note', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => setNote(ctx, 'b', 'не потерять'));
    expect(run(() => mergeUp(ctx, 'b'))).toBeUndefined();
    expect(doc.get('b').note).toBe('не потерять');
  });
});

describe('block commands (a selection)', () => {
  it('indents and outdents consecutive bullets together, keeping their order', () => {
    const { doc, ctx, run } = setup(['a', 'b', 'c', 'd']);
    run(() => cmd.indentMany(ctx, ['b', 'c']));
    expect(dump(doc)).toEqual(['a', '  b', '  c', 'd']);
    run(() => cmd.outdentMany(ctx, ['b', 'c']));
    expect(dump(doc)).toEqual(['a', 'b', 'c', 'd']);
    // A first bullet with no previous sibling holds the whole block.
    run(() => cmd.indentMany(ctx, ['a', 'b']));
    expect(dump(doc)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('moves a block up and down whole, and not past the edges', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  b1', 'c', 'd']);
    run(() => cmd.moveUpMany(ctx, ['b', 'c']));
    expect(dump(doc)).toEqual(['b', '  b1', 'c', 'a', 'd']);
    run(() => cmd.moveUpMany(ctx, ['b', 'c']));
    expect(dump(doc)).toEqual(['b', '  b1', 'c', 'a', 'd']);
    run(() => cmd.moveDownMany(ctx, ['b', 'c']));
    run(() => cmd.moveDownMany(ctx, ['b', 'c']));
    run(() => cmd.moveDownMany(ctx, ['b', 'c']));
    expect(dump(doc)).toEqual(['a', 'd', 'b', '  b1', 'c']);
  });

  it('deletes bullets with their subtrees and focuses the row above', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  b1', 'c', 'd']);
    const focus = run(() => cmd.deleteMany(ctx, ['b', 'c']));
    expect(dump(doc)).toEqual(['a', 'd']);
    expect(focus).toEqual({ id: 'a', caret: 1 });
  });

  it('copies the bullets with their subtrees as Markdown', () => {
    const { doc } = setup(['a', 'b', '  b1', 'c']);
    expect(markdownOf(doc, ['b', 'c'])).toBe('- b\n  - b1\n- c\n');
  });
});

describe('moveManyInto ("Переместить в…")', () => {
  it('puts the bullets last under the target, in their order, with their subtrees; its folding stays', () => {
    const { doc, ctx, run } = setup(['Inbox', '  a', '    a1', '  b', '  c', 'Projects [+]', '  p']);
    expect(run(() => cmd.moveManyInto(ctx, ['a', 'c'], 'Projects'))).toBe(2);
    expect(dump(doc)).toEqual(['Inbox', '  b', 'Projects [+]', '  p', '  a', '    a1', '  c']);
  });

  it('refuses a target inside what moves, and under a mirror goes to its original', () => {
    const { doc, ctx, run } = setup(['a', '  a1', 'b', 'x']);
    expect(run(() => cmd.moveManyInto(ctx, ['a'], 'a1'))).toBe(0);
    expect(run(() => cmd.moveManyInto(ctx, ['a'], 'a'))).toBe(0);
    run(() => doc.apply({ t: 'setMirror', id: 'x', from: null, to: 'b' }));
    expect(run(() => cmd.moveManyInto(ctx, ['a'], 'x'))).toBe(1);
    expect(dump(doc)).toEqual(['b', '  a', '    a1', 'x']);
  });
});

describe('moveManyTo (drag and drop)', () => {
  it('moves within a parent, across parents and to the first place', () => {
    const { doc, ctx, run } = setup(['a', 'b', '  b1', 'c', 'd']);
    run(() => cmd.moveManyTo(ctx, ['a'], doc.root, 'c'));
    expect(dump(doc)).toEqual(['b', '  b1', 'c', 'a', 'd']);
    run(() => cmd.moveManyTo(ctx, ['d'], 'b', null));
    expect(dump(doc)).toEqual(['b', '  d', '  b1', 'c', 'a']);
    run(() => cmd.moveManyTo(ctx, ['a'], doc.root, null));
    expect(dump(doc)).toEqual(['a', 'b', '  d', '  b1', 'c']);
    checkInvariants(doc);
  });

  it('keeps a block in order, including when dropped right after itself or among its own keys', () => {
    const { doc, ctx, run } = setup(['a', 'b', 'c', 'd', 'e']);
    run(() => cmd.moveManyTo(ctx, ['b', 'c'], doc.root, 'c'));
    expect(dump(doc)).toEqual(['a', 'b', 'c', 'd', 'e']);
    run(() => cmd.moveManyTo(ctx, ['b', 'd'], doc.root, 'a'));
    expect(dump(doc)).toEqual(['a', 'b', 'd', 'c', 'e']);
    run(() => cmd.moveManyTo(ctx, ['a', 'c', 'e'], doc.root, 'd'));
    expect(dump(doc)).toEqual(['b', 'd', 'a', 'c', 'e']);
    checkInvariants(doc);
  });

  it('refuses a drop inside a moved subtree, and expands a collapsed new parent', () => {
    const { doc, ctx, run } = setup(['a', '  a1', 'b [+]', '  b1']);
    run(() => cmd.moveManyTo(ctx, ['a'], 'a1', null));
    expect(dump(doc)).toEqual(['a', '  a1', 'b [+]', '  b1']);
    run(() => cmd.moveManyTo(ctx, ['a'], 'b', 'b1'));
    expect(dump(doc)).toEqual(['b', '  b1', '  a', '    a1']);
  });
});

describe('tasks (checkbox bullets)', () => {
  it('Ctrl+L goes round three states: a task, checked, plain again; a click on the box only checks and unchecks', () => {
    const { doc, ctx, run } = setup(['a']);
    const state = () => ({ todo: doc.get('a').todo, done: doc.get('a').done });
    run(() => cmd.cycleTask(ctx, ['a']));
    expect(state()).toEqual({ todo: true, done: false });
    run(() => cmd.cycleTask(ctx, ['a']));
    expect(state()).toEqual({ todo: true, done: true });
    run(() => cmd.cycleTask(ctx, ['a']));
    expect(state()).toEqual({ todo: false, done: false });
    run(() => cmd.cycleTask(ctx, ['a']));
    expect(state()).toEqual({ todo: true, done: false });
    run(() => cmd.toggleDone(ctx, ['a']));
    run(() => cmd.toggleDone(ctx, ['a']));
    expect(state()).toEqual({ todo: true, done: false });
    run(() => cmd.untask(ctx, ['a']));
    expect(state()).toEqual({ todo: false, done: false });
  });

  it('on several bullets, makes the plain ones tasks first, then checks them all', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => cmd.cycleTask(ctx, ['a']));
    run(() => cmd.cycleTask(ctx, ['a', 'b']));
    expect([doc.get('a'), doc.get('b')].map((n) => [n.todo, n.done])).toEqual([[true, false], [true, false]]);
    run(() => cmd.cycleTask(ctx, ['a', 'b']));
    expect([doc.get('a'), doc.get('b')].map((n) => [n.todo, n.done])).toEqual([[true, true], [true, true]]);
    run(() => cmd.cycleTask(ctx, ['a', 'b']));
    expect([doc.get('a'), doc.get('b')].map((n) => [n.todo, n.done])).toEqual([[false, false], [false, false]]);
  });

  it('writes tasks as - [ ] / - [x] and reads them back', () => {
    const { doc, ctx, run } = setup(['открытая', 'закрытая', 'текст']);
    run(() => cmd.cycleTask(ctx, ['открытая', 'закрытая']));
    run(() => cmd.cycleTask(ctx, ['закрытая']));
    const md = markdownOf(doc, doc.get(doc.root).children);
    expect(md).toBe('- [ ] открытая\n- [x] закрытая\n- текст\n');
    expect(parseIndented(md).map((t) => [t.text, !!t.todo, !!t.done])).toEqual([
      ['открытая', true, false], ['закрытая', true, true], ['текст', false, false],
    ]);
  });
});

