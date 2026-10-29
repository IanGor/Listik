import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { invert } from '../src/model/doc';
import { compareOrder } from '../src/model/links';
import { PendingTasks } from '../src/model/tasks';
import type { NodeId, Op } from '../src/model/types';
import { rng, setup } from './helpers';

/** The open tasks inside `id`, the slow way: a walk, top first. */
function brute(doc: ReturnType<typeof setup>['doc'], id: NodeId): { task: NodeId; count: number } | null {
  const found: NodeId[] = [];
  doc.walk(id, (n) => {
    if (n.id !== id && n.todo && !n.done && !n.mirrorOf) found.push(n.id);
  });
  if (!found.length) return null;
  found.sort((a, b) => compareOrder(doc, a, b));
  return { task: found[0], count: found.length };
}

describe('open tasks', () => {
  it('the first open one inside a bullet, top first, with how many; checked ones and the bullet itself do not count', () => {
    const { doc, ctx, run } = setup(['a', '  b', '    c', '  d', 'e']);
    const tasks = new PendingTasks(doc);
    expect(tasks.inside('a')).toBeNull();
    run(() => cmd.toggleTask(ctx, ['d', 'c', 'a']));
    expect(tasks.inside('a')).toEqual({ task: 'c', count: 2 });
    expect(tasks.inside('b')).toEqual({ task: 'c', count: 1 });
    expect(tasks.isOpen('a')).toBe(true);
    run(() => cmd.toggleDone(ctx, ['c']));
    expect(tasks.inside('a')).toEqual({ task: 'd', count: 1 });
    expect(tasks.inside('b')).toBeNull();
    run(() => cmd.deleteNode(ctx, 'd'));
    expect(tasks.inside('a')).toBeNull();
  });

  it('stays equal to a walk under random editing, deleting and undoing', () => {
    let steps = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, ctx, rows } = setup(['a', '  b', '    c', '  d', 'e', '  f', 'g']);
      const tasks = new PendingTasks(doc);
      const history: Op[][] = [];
      for (let step = 0; step < 150; step++) {
        if (!rows.length) break;
        steps++;
        const key = pick(rows.ids);
        const action = pick<() => unknown>([
          () => cmd.toggleTask(ctx, [key]),
          () => cmd.toggleDone(ctx, [key]),
          () => cmd.untask(ctx, [key]),
          () => cmd.indent(ctx, key),
          () => cmd.outdent(ctx, key),
          () => cmd.moveDown(ctx, key),
          () => cmd.split(ctx, key, 0),
          () => (rows.length > 3 ? cmd.deleteNode(ctx, key) : undefined),
          () => {
            const ops = history.pop();
            if (ops) [...ops].reverse().forEach((op) => doc.apply(invert(op)));
          },
        ]);
        history.push(doc.transact(() => { action(); }));
        for (const id of [...doc.nodes.keys()].filter((x) => doc.inOutline(x))) {
          expect(tasks.inside(id), `seed ${seed} step ${step} ${id}`).toEqual(brute(doc, id));
        }
      }
    }
    expect(steps).toBeGreaterThan(1000);
  });
});
