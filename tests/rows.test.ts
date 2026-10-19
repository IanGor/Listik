import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { invert } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { VisibleRows } from '../src/model/rows';
import { Virtualizer } from '../src/view/virtualizer';
import type { Op } from '../src/model/types';
import { dump, dumpRows, rng, setup } from './helpers';

describe('VisibleRows', () => {
  it('lists rows in pre-order and skips collapsed subtrees', () => {
    const { doc, rows } = setup(['a', '  b [+]', '    hidden', '  c', 'd']);
    expect(dumpRows(rows, doc)).toEqual(['a', '  b [+]', '  c', 'd']);
    expect(rows.subtreeEnd(0)).toBe(3);
  });

  it('stays equal to a full rebuild under random editing, and undoes back to the start', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx } = setup(['a', '  b', '    c', 'd', '  e', 'f']);
      const initial = dump(doc);
      const history: Op[][] = [];
      // Splice notifications must be enough to mirror the list...
      const mirror = [...rows.ids];
      rows.subscribe({
        splice: (at, removed, inserted) => mirror.splice(at, removed, ...rows.ids.slice(at, at + inserted)),
      });
      // ...and to keep the virtualizer's layout in step.
      const estimate = (id: string) => 10 + doc.get(id).text.length;
      const v = new Virtualizer(rows, estimate);

      for (let step = 0; step < 300; step++) {
        const id = pick(rows.ids);
        const n = doc.get(id);
        const action = pick([
          () => cmd.split(ctx, id, Math.floor(rand() * (n.text.length + 1))),
          () => cmd.mergeUp(ctx, id),
          () => cmd.deleteNode(ctx, id),
          () => cmd.indent(ctx, id),
          () => cmd.outdent(ctx, id),
          () => cmd.moveUp(ctx, id),
          () => cmd.moveDown(ctx, id),
          () => cmd.setCollapsed(ctx, id, !n.collapsed),
          () => cmd.setText(ctx, id, n.text + 'xyz'[Math.floor(rand() * 3)]),
        ]);
        history.push(doc.transact(() => { action(); }));

        checkInvariants(doc);
        const fresh = new VisibleRows(doc);
        fresh.dispose();
        expect(rows.ids, `seed ${seed} step ${step}`).toEqual(fresh.ids);
        expect(rows.depths, `seed ${seed} step ${step}`).toEqual(fresh.depths);
        expect(mirror).toEqual(rows.ids);
        // One height per row (estimates are > 0, a missing entry reads as 0), summing to the total.
        let sum = 0;
        for (let i = 0; i < rows.length; i++) {
          expect(v.heightOf(i)).toBeGreaterThan(0);
          sum += v.heightOf(i);
        }
        expect(v.heightOf(rows.length)).toBe(0);
        expect(v.total).toBe(sum);
      }

      for (const ops of history.reverse()) {
        doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
      }
      expect(dump(doc)).toEqual(initial);
      expect(dumpRows(rows, doc)).toEqual(initial);
    }
  });

  it('rebuilds once instead of patching for big transactions (> PATCH_LIMIT ops), with the same result', () => {
    const lines = Array.from({ length: 150 }, (_, i) => [`top${i}`, `  kid${i}`]).flat();
    const { doc, rows, ctx } = setup(lines);
    const v = new Virtualizer(rows, () => 20);
    const resets: number[] = [];
    rows.subscribe({ reset: () => resets.push(rows.length) });
    const check = () => {
      const fresh = new VisibleRows(doc);
      fresh.dispose();
      expect(rows.ids).toEqual(fresh.ids);
      expect(rows.depths).toEqual(fresh.depths);
      expect(v.total).toBe(rows.length * 20);
    };

    const ops = doc.transact(() => cmd.collapseChildren(ctx, doc.root));
    expect(ops).toHaveLength(150);
    expect(rows.length).toBe(150);
    expect(resets).toEqual([150]);
    check();

    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(rows.length).toBe(300);
    check();

    // A failed big transaction is rolled back, and the rows follow.
    expect(() => doc.transact(() => {
      cmd.collapseChildren(ctx, doc.root);
      throw new Error('boom');
    })).toThrow('boom');
    expect(rows.length).toBe(300);
    check();
  });

  it('hides completed bullets with their subtrees, patching on completion and its undo', () => {
    const { doc, rows, ctx } = setup(['a', '  a1', 'b', 'c', '  c1']);
    rows.setHideDone(true);
    const check = () => {
      const fresh = new VisibleRows(doc);
      fresh.setHideDone(true);
      fresh.dispose();
      expect(rows.ids).toEqual(fresh.ids);
      expect(rows.depths).toEqual(fresh.depths);
    };
    const ops = doc.transact(() => cmd.toggleDone(ctx, ['a']));
    expect(dumpRows(rows, doc)).toEqual(['b', 'c', '  c1']);
    check();
    doc.transact(() => cmd.toggleDone(ctx, ['c1']));
    expect(dumpRows(rows, doc)).toEqual(['b', 'c']);
    // Its only child is completed and hidden: "c" is open, and empty; no halo, nothing to unfold.
    expect(rows.hasHiddenChildren('c')).toBe(false);
    expect(rows.unfolded('c')).toBe(true);
    expect(rows.showsChildren('c')).toBe(false);
    // Folded, it is closed, still with no halo (only completed bullets under it); open again, empty.
    doc.transact(() => cmd.setCollapsed(ctx, 'c', true));
    expect(rows.unfolded('c')).toBe(false);
    expect(rows.hasHiddenChildren('c')).toBe(false);
    doc.transact(() => cmd.setCollapsed(ctx, 'c', false));
    expect(rows.unfolded('c')).toBe(true);
    doc.transact(() => [...ops].reverse().forEach((op) => doc.apply(invert(op))));
    expect(dumpRows(rows, doc)).toEqual(['a', '  a1', 'b', 'c']);
    check();
    rows.setHideDone(false);
    expect(dumpRows(rows, doc)).toEqual(['a', '  a1', 'b', 'c', '  c1']);
  });

  it('stays equal to a rebuild under random completion and editing while completed are hidden', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx } = setup(['a', '  b', '    c', 'd', '  e', 'f', 'g']);
      rows.setHideDone(true);
      for (let step = 0; step < 200; step++) {
        if (!rows.length) {
          doc.transact(() => { for (const id of [...doc.nodes.keys()]) if (doc.get(id).done) cmd.toggleDone(ctx, [id]); });
          continue;
        }
        const id = pick(rows.ids);
        const ids = [...doc.nodes.keys()].filter((x) => x !== doc.root);
        const action = pick([
          () => cmd.toggleDone(ctx, [id]),
          () => cmd.toggleDone(ctx, [pick(ids)]),
          () => cmd.toggleDone(ctx, ids.slice(0, 1 + Math.floor(rand() * ids.length))),
          () => cmd.split(ctx, id, 0),
          () => cmd.indent(ctx, id),
          () => cmd.outdent(ctx, id),
          () => cmd.moveDown(ctx, id),
          () => cmd.deleteNode(ctx, id),
        ]);
        doc.transact(() => { action(); });
        const fresh = new VisibleRows(doc);
        fresh.setHideDone(true);
        fresh.dispose();
        expect(rows.ids, `seed ${seed} step ${step}`).toEqual(fresh.ids);
        expect(rows.depths, `seed ${seed} step ${step}`).toEqual(fresh.depths);
      }
    }
  });
});

