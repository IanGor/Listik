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
