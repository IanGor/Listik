import { describe, expect, it, vi } from 'vitest';
import { Doc, invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import type { Op } from '../src/model/types';
import { build, dump } from './helpers';

describe('Doc', () => {
  it('starts with a single empty bullet', () => {
    const doc = Doc.withEmptyBullet();
    expect(dump(doc)).toEqual(['']);
    checkInvariants(doc);
  });

  it('removes and re-inserts a whole subtree', () => {
    const doc = build(['a', '  b', '    c', 'd']);
    const op: Op = { t: 'remove', parent: doc.root, node: doc.snapshot('a') };
    doc.apply(op);
    expect(dump(doc)).toEqual(['d']);
    expect(doc.has('c')).toBe(false);
    doc.apply(invert(op));
    expect(dump(doc)).toEqual(['a', '  b', '    c', 'd']);
    checkInvariants(doc);
  });

  it('inverts setText, move and setCollapsed', () => {
    const doc = build(['a', '  b', 'c']);
    const ops = doc.transact(() => {
      doc.apply({ t: 'setText', id: 'c', from: 'c', to: 'C' });
      doc.apply({ t: 'setCollapsed', id: 'a', from: false, to: true });
      doc.apply({
        t: 'move', id: 'c',
        from: { parent: doc.root, order: doc.get('c').order },
        to: { parent: 'a', order: doc.orderAt('a', 0) },
      });
    });
    expect(dump(doc)).toEqual(['a [+]', '  C', '  b']);
    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dump(doc)).toEqual(['a', '  b', 'c']);
    checkInvariants(doc);
  });

  it('refuses to move a node into its own subtree', () => {
    const doc = build(['a', '  b']);
    expect(() => doc.apply({
      t: 'move', id: 'a',
      from: { parent: doc.root, order: doc.get('a').order },
      to: { parent: 'b', order: doc.orderAt('b', 0) },
    })).toThrow(/own subtree/);
    expect(dump(doc)).toEqual(['a', '  b']);
  });

  it('refuses ops built against a stale state', () => {
    const doc = build(['a']);
    expect(() => doc.apply({ t: 'setText', id: 'a', from: 'x', to: 'y' })).toThrow(/stale/);
  });

  it('rolls back a failed transaction without committing', () => {
    const doc = build(['a', 'b']);
    const commit = vi.fn();
    doc.subscribe({ commit });
    expect(() => doc.transact(() => {
      doc.apply({ t: 'setText', id: 'a', from: 'a', to: 'A' });
      doc.apply({ t: 'setText', id: 'b', from: 'wrong', to: 'B' });
    })).toThrow();
    expect(dump(doc)).toEqual(['a', 'b']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('notifies listeners per op and commits once per transaction', () => {
    const doc = build(['a', 'b']);
    const op = vi.fn();
    const commit = vi.fn();
    doc.subscribe({ op, commit });
    doc.transact(() => {
      doc.apply({ t: 'setText', id: 'a', from: 'a', to: 'A' });
      doc.apply({ t: 'setText', id: 'b', from: 'b', to: 'B' });
    });
    expect(op).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toHaveLength(2);
  });
});

describe('done and notes', () => {
  it('applies and inverts setDone and setNote, refusing stale ones', () => {
    const doc = build(['a']);
    const ops = doc.transact(() => {
      doc.apply({ t: 'setDone', id: 'a', from: false, to: true });
      doc.apply({ t: 'setNote', id: 'a', from: '', to: 'строка 1\nстрока 2', at: 5 });
    });
    expect(doc.get('a')).toMatchObject({ done: true, note: 'строка 1\nстрока 2', updated: 5 });
    expect(() => doc.apply({ t: 'setDone', id: 'a', from: false, to: true })).toThrow(/stale/);
    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(doc.get('a')).toMatchObject({ done: false, note: '' });
    const snap = doc.snapshot('a');
    expect(snap).toMatchObject({ done: false, note: '' });
  });

  it('keeps when a task was checked (doneAt), and gives it back when an uncheck is undone', () => {
    const doc = build(['a']);
    const check: Op = { t: 'setDone', id: 'a', from: false, to: true, at: 7 };
    doc.apply(check);
    expect(doc.get('a').doneAt).toBe(7);
    const uncheck: Op = { t: 'setDone', id: 'a', from: true, to: false, at: 7 };
    doc.apply(uncheck);
    expect(doc.get('a').doneAt).toBeUndefined();
    doc.apply(invert(uncheck));
    expect(doc.get('a')).toMatchObject({ done: true, doneAt: 7 });
    expect(doc.snapshot('a').doneAt).toBe(7);
    doc.apply(invert(check));
    expect(doc.get('a').doneAt).toBeUndefined();
    // An op from before doneAt checks the task with no stamp.
    doc.apply({ t: 'setDone', id: 'a', from: false, to: true });
    expect(doc.get('a')).toMatchObject({ done: true });
    expect(doc.get('a').doneAt).toBeUndefined();
  });
});
