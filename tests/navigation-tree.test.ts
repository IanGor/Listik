import { describe, expect, it } from 'vitest';
import { navigationRows, navigationSelection, revealNavigation } from '../src/view/navigation-tree';
import { setup } from './helpers';
import { serialize } from '../src/persist/serialize';
import { deleteNode } from '../src/model/commands';

describe('read-only navigation tree', () => {
  it('keeps its folds independent from document folds without applying operations', () => {
    const { doc } = setup(['A [+]', '  B [+]', '    C', 'D']);
    const before = serialize(doc);
    expect(navigationRows(doc, new Set()).map((r) => r.key)).toEqual(['A', 'D']);
    const open = new Set(['A', 'A/B']);
    expect(navigationRows(doc, open).map((r) => [r.key, r.depth])).toEqual([['A', 0], ['A/B', 1], ['A/B/C', 2], ['D', 0]]);
    expect(serialize(doc)).toEqual(before);
    expect(navigationSelection(navigationRows(doc, new Set()), doc, 'C')).toBe('A');
    expect(navigationSelection(navigationRows(doc, open), doc, 'C')).toBe('A/B/C');
  });

  it('reveals the current path without closing neighbouring branches', () => {
    const { doc } = setup(['A', '  B', '    C', 'D', '  E']);
    const original = new Set(['D']);
    const expanded = revealNavigation(doc, 'C', original);
    expect([...expanded]).toEqual(['D', 'A', 'A/B']);
    expect([...original]).toEqual(['D']);
    expect(revealNavigation(doc, 'missing', expanded)).toEqual(expanded);
  });

  it('shows mirror contents, prevents cycles and marks the selected occurrence', () => {
    const { doc, run } = setup(['A', '  B', '  Loop', 'Copy']);
    run(() => {
      doc.apply({ t: 'setMirror', id: 'Copy', from: null, to: 'A' });
      doc.apply({ t: 'setMirror', id: 'Loop', from: null, to: 'A' });
    });
    const rows = navigationRows(doc, new Set(['A', 'A/Loop', 'Copy', 'Copy/Loop']));
    expect(rows.map((r) => r.key)).toEqual(['A', 'A/B', 'A/Loop', 'Copy', 'Copy/B', 'Copy/Loop']);
    expect(rows.filter((r) => r.id === 'Loop').every((r) => !r.children)).toBe(true);
    expect(navigationSelection(rows, doc, 'B', 'Copy/B')).toBe('Copy/B');
    expect(navigationSelection(navigationRows(doc, new Set()), doc, 'B', 'Copy/B')).toBe('Copy');
  });

  it('updates names, positions and removed branches while retaining local folds', () => {
    const { doc, ctx, run } = setup(['A', '  B', 'C']);
    const open = new Set(['A']);
    run(() => doc.apply({ t: 'setText', id: 'B', from: 'B', to: 'Renamed' }));
    expect(doc.get(navigationRows(doc, open)[1].id).text).toBe('Renamed');
    run(() => deleteNode(ctx, 'A'));
    expect(navigationRows(doc, open).map((r) => r.id)).toEqual(['C']);
  });
});
