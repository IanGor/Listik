import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { checkInvariants } from '../src/model/invariants';
import { VisibleRows, keepSet } from '../src/model/rows';
import { TagIndex } from '../src/model/tags';
import type { Focus } from '../src/model/types';
import { dumpRows, rng, setup } from './helpers';

const DOC = ['a', '  b [+]', '    c #x', '    d', '  e', 'f #x', '  g'];

function zoomed(top: string, lines = DOC) {
  const env = setup(lines);
  env.rows.setTop(top);
  return env;
}

describe('zoom', () => {
  it('shows the zoomed-in bullet’s children as the top level, even if it is collapsed', () => {
    const { doc, rows } = zoomed('b'); // fixture ids drop the [+] marker
    expect(dumpRows(rows, doc)).toEqual(['c #x', 'd']);
    expect(rows.contains('c #x')).toBe(true);
    expect(rows.contains('b')).toBe(false);
    expect(rows.contains('f #x')).toBe(false);
  });

  it('ignores changes outside the zoomed-in bullet and follows those inside', () => {
    const { doc, rows, ctx, run } = zoomed('a');
    run(() => cmd.split(ctx, 'f #x', 1));
    expect(dumpRows(rows, doc)).toEqual(['b [+]', 'e']);
    run(() => cmd.split(ctx, 'e', 1));
    expect(dumpRows(rows, doc)).toEqual(['b [+]', 'e', '']);
    // Moving a bullet in from outside shows it; moving it out hides it.
    run(() => cmd.moveUp(ctx, 'f #x'));
    expect(dumpRows(rows, doc)).toEqual(['b [+]', 'e', '']);
  });

  it('keeps Shift+Tab and moves inside the zoomed-in bullet', () => {
    const { doc, rows, ctx, run } = zoomed('a');
    run(() => cmd.outdent(ctx, 'e'));
    run(() => cmd.moveUp(ctx, 'b'));
    run(() => cmd.moveDown(ctx, 'e'));
    expect(dumpRows(rows, doc)).toEqual(['b [+]', 'e']);
    expect(doc.get('e').parent).toBe('a');
    // Deeper levels still move across their parents, inside the zoom.
    rows.setTop(doc.root);
    run(() => cmd.setCollapsed(ctx, 'b', false));
    rows.setTop('a');
    run(() => cmd.moveDown(ctx, 'd'));
    expect(dumpRows(rows, doc)).toEqual(['b', '  c #x', 'e', '  d']);
  });

  it('starts the first child from the title', () => {
    const { doc, rows, ctx, run } = zoomed('g', [...DOC]);
    expect(rows.length).toBe(0);
    const focus = run(() => cmd.prependChild(ctx, 'g'));
    expect(dumpRows(rows, doc)).toEqual(['']);
    expect(rows.ids[0]).toBe(focus.id);
  });

  it('the "+" appends an empty last child, even under collapsed children', () => {
    const { doc, rows, ctx, run } = zoomed('b');
    const focus = run(() => cmd.appendChild(ctx, 'b'));
    expect(dumpRows(rows, doc)).toEqual(['c #x', 'd', '']);
    expect(rows.ids[2]).toBe(focus.id);
    expect(focus.caret).toBe(0);
  });

  it('searches only inside the zoomed-in bullet; nothing found shows nothing', () => {
    const { doc, rows } = zoomed('a');
    const tags = new TagIndex(doc);
    const inside = [...tags.nodesWith('x')].filter((id) => rows.contains(id));
    rows.setFilter({ keep: keepSet(doc, inside, rows.top), open: new Set() });
    expect(dumpRows(rows, doc)).toEqual(['b [+]', '  c #x']);
    rows.setFilter({ keep: keepSet(doc, [], rows.top), open: new Set() });
    expect(rows.length).toBe(0);
  });

  it('under random editing while zoomed in: rows match a rebuild and stay inside', () => {
    let steps = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const { doc, rows, ctx } = setup(['out', 'a', '  b', '    c', '    d', '  e', '    f', 'after']);
      rows.setTop('a');
      for (let step = 0; step < 300; step++) {
        if (!rows.length) {
          doc.transact(() => { cmd.prependChild(ctx, 'a'); });
          continue;
        }
        steps++;
        const id = pick(rows.ids);
        const n = doc.get(id);
        const action = pick<() => Focus | string | void>([
          () => cmd.split(ctx, id, Math.floor(rand() * (n.text.length + 1))),
          () => cmd.mergeUp(ctx, id),
          () => cmd.deleteNode(ctx, id),
          () => cmd.indent(ctx, id),
          () => cmd.outdent(ctx, id),
          () => cmd.moveUp(ctx, id),
          () => cmd.moveDown(ctx, id),
          () => cmd.setCollapsed(ctx, id, !n.collapsed),
          () => cmd.insertText(ctx, id, 0, 0, ['p', 'q']),
        ]);
        doc.transact(() => { action(); });

        checkInvariants(doc);
        expect(doc.get('out').parent).toBe(doc.root);
        expect(doc.get('after').parent).toBe(doc.root);
        for (const r of rows.ids) expect(rows.contains(r)).toBe(true);
        const fresh = new VisibleRows(doc);
        fresh.setTop('a');
        fresh.dispose();
        expect(rows.ids, `seed ${seed} step ${step}`).toEqual(fresh.ids);
        expect(rows.depths, `seed ${seed} step ${step}`).toEqual(fresh.depths);
      }
    }
    expect(steps).toBeGreaterThan(20 * 300 * 0.9);
  });
});
