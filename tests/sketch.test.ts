import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { invert } from '../src/model/doc';
import { History } from '../src/model/history';
import { checkInvariants } from '../src/model/invariants';
import { applyMerged } from '../src/model/merge';
import { decodePoints, drawStroke, encodePoints, eraseStrokes, pathData, simplify, smooth, touches, type Point } from '../src/model/sketch';
import { rng } from './helpers';
import type { Stroke } from '../src/model/types';
import { deserialize, serialize } from '../src/persist/serialize';
import { setup } from './helpers';

const line = (id: string, tool: Stroke['tool'] = 'pen'): Stroke => ({ id, tool, d: encodePoints([[0, 0], [10, 10]]) });
const ids = (strokes: Stroke[] | undefined) => strokes?.map((s) => s.id) ?? [];

describe('points', () => {
  it('round-trip at half-unit precision, as steps from the point before', () => {
    const points: Point[] = [[12.3, 40], [12.5, 41.2], [999.7, 0.26]];
    expect(decodePoints(encodePoints(points))).toEqual([[12.5, 40], [12.5, 41], [999.5, 0.5]]);
    expect(encodePoints([[1, 2], [2, 2]])).toBe('2 4 2 0');
    expect(decodePoints('')).toEqual([]);
  });

  it('simplify drops points on a straight run and keeps the corners', () => {
    const run: Point[] = [[0, 0], [1, 0.1], [2, 0], [3, -0.1], [4, 0], [4, 5]];
    expect(simplify(run, 0.5)).toEqual([[0, 0], [4, 0], [4, 5]]);
    expect(simplify([[0, 0], [1, 1]], 0.5)).toEqual([[0, 0], [1, 1]]);
  });

  it('touches finds a line near a point, a dot included', () => {
    expect(touches([[0, 0], [100, 0]], [50, 4], 5)).toBe(true);
    expect(touches([[0, 0], [100, 0]], [50, 6], 5)).toBe(false);
    expect(touches([[10, 10]], [12, 12], 3)).toBe(true);
  });

  it('the curve goes through every point; a single point draws as a dot', () => {
    expect(pathData([[5, 5]])).toBe('M5 5l0 0');
    expect(pathData([[0, 0], [10, 0]])).toBe('M0 0C0 0 10 0 10 0');
    const d = pathData([[0, 0], [10, 0], [10, 10], [0, 10]]);
    // Three cubic pieces ending at the points themselves.
    expect(d.match(/C[^C]+/g)!.map((c) => c.trim().split(' ').slice(-2).join(' '))).toEqual(['10 0', '10 10', '0 10']);
    // A right-angled turn bulges only a little past the corner (centripetal: no loops).
    for (const n of d.replace(/[MC]/g, ' ').trim().split(/\s+/).map(Number)) expect(n >= -2 && n <= 12).toBe(true);
  });
});

describe('smooth', () => {
  const wobble = (seed: number, amp: number) => {
    const r = rng(seed);
    return (p: Point): Point => [p[0] + (r() * 2 - 1) * amp, p[1] + (r() * 2 - 1) * amp];
  };
  const spread = (pts: Point[]) => Math.sqrt(pts.reduce((a, p) => a + p[1] * p[1], 0) / pts.length);

  it('takes the tremor out of a straight line; the ends stay', () => {
    const shaky = Array.from({ length: 200 }, (_, i): Point => [i * 0.5, 0]).map(wobble(1, 0.6));
    const out = smooth(shaky, 2);
    expect(out[0]).toEqual(shaky[0]);
    expect(out[199]).toEqual(shaky[199]);
    expect(spread(out.slice(20, 180))).toBeLessThan(spread(shaky.slice(20, 180)) / 3);
  });

  it('keeps a sharp corner sharp', () => {
    const corner: Point[] = [
      ...Array.from({ length: 41 }, (_, i): Point => [i * 0.5, 0]),
      ...Array.from({ length: 40 }, (_, i): Point => [20, (i + 1) * 0.5]),
    ];
    const out = smooth(corner, 2);
    expect(out[40]).toEqual([20, 0]);
    // Both arms stay straight right up to it: no rounding pulls them off their lines.
    for (let i = 30; i < 40; i++) expect(Math.abs(out[i][1])).toBeLessThan(0.01);
    for (let i = 41; i < 50; i++) expect(Math.abs(out[i][0] - 20)).toBeLessThan(0.01);
  });

  it('keeps a small loop round and almost its size', () => {
    const r = 6;
    const loop = Array.from({ length: 120 }, (_, i): Point => [Math.cos(i / 15) * r, Math.sin(i / 15) * r]).map(wobble(2, 0.4));
    const out = smooth(loop, 2);
    const radii = out.slice(20, 100).map((p) => Math.hypot(p[0], p[1]));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(mean).toBeGreaterThan(r * 0.9);
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.6);
  });

  it('leaves the line as it was with nothing to smooth', () => {
    const pts: Point[] = [[0, 0], [1, 1], [2, 0]];
    expect(smooth(pts, 0)).toBe(pts);
    expect(smooth(pts.slice(0, 2), 2)).toEqual(pts.slice(0, 2));
  });
});

describe('sketch ops', () => {
  it('lines are added in order and erased whole; undo brings them back', () => {
    const { doc, ctx, run } = setup(['a']);
    run(() => drawStroke(ctx, 'a', line('s1')));
    run(() => drawStroke(ctx, 'a', line('s2', 'mark')));
    expect(ids(doc.get('a').strokes)).toEqual(['s1', 's2']);
    const ops = doc.transact(() => eraseStrokes(ctx, 'a', new Set(['s1', 'missing'])));
    expect(ids(doc.get('a').strokes)).toEqual(['s2']);
    doc.transact(() => ops.map(invert).forEach((op) => doc.apply(op)));
    expect(ids(doc.get('a').strokes)).toEqual(['s2', 's1']);
    run(() => eraseStrokes(ctx, 'a', new Set(['s1', 's2'])));
    expect(doc.get('a').strokes).toBeUndefined();
    checkInvariants(doc);
  });

  it('a stale op is refused: the same line twice, or one that is not there', () => {
    const { doc, ctx, run } = setup(['a']);
    run(() => drawStroke(ctx, 'a', line('s1')));
    expect(() => doc.apply({ t: 'addStrokes', id: 'a', strokes: [line('s1')] })).toThrow(/already has/);
    expect(() => doc.apply({ t: 'removeStrokes', id: 'a', strokes: [line('nope')] })).toThrow(/stale/);
  });

  it('two devices drawing at once add up; erasing twice erases once', () => {
    const { doc, ctx, run } = setup(['a']);
    run(() => drawStroke(ctx, 'a', line('mine')));
    expect(applyMerged(doc, { t: 'addStrokes', id: 'a', strokes: [line('mine'), line('theirs')] })).toEqual([
      { t: 'addStrokes', id: 'a', strokes: [line('theirs')] },
    ]);
    expect(ids(doc.get('a').strokes)).toEqual(['mine', 'theirs']);
    run(() => eraseStrokes(ctx, 'a', new Set(['mine'])));
    expect(applyMerged(doc, { t: 'removeStrokes', id: 'a', strokes: [line('mine'), line('theirs')] })).toEqual([
      { t: 'removeStrokes', id: 'a', strokes: [line('theirs')] },
    ]);
    expect(doc.get('a').strokes).toBeUndefined();
    expect(applyMerged(doc, { t: 'removeStrokes', id: 'a', strokes: [line('theirs')] })).toEqual([]);
    expect(applyMerged(doc, { t: 'addStrokes', id: 'gone', strokes: [line('x')] })).toEqual([]);
  });

  it('undo and redo go through the history like any edit', () => {
    const { doc, ctx } = setup(['a']);
    const history = new History();
    const ops = doc.transact(() => drawStroke(ctx, 'a', line('s1')));
    history.record({ ops, before: null, after: null });
    history.undo(doc);
    expect(doc.get('a').strokes).toBeUndefined();
    history.redo(doc);
    expect(ids(doc.get('a').strokes)).toEqual(['s1']);
  });

  it('a mirror draws on its original, and the sketch goes along when the original is deleted', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => cmd.makeMirror(ctx, 'b', 'a', 0, 1));
    expect(doc.get('b').mirrorOf).toBe('a');
    run(() => drawStroke(ctx, 'b', line('s1')));
    expect(ids(doc.get('a').strokes)).toEqual(['s1']);
    expect(doc.get('b').strokes).toBeUndefined();
    run(() => cmd.deleteNode(ctx, 'a'));
    expect(doc.get('b').mirrorOf).toBeNull();
    expect(ids(doc.get('b').strokes)).toEqual(['s1']);
    checkInvariants(doc);
  });

  it('a deleted bullet keeps its sketch in the trash and brings it back', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => drawStroke(ctx, 'a', line('s1')));
    const snap = doc.snapshot('a');
    expect(ids(snap.strokes)).toEqual(['s1']);
    doc.apply({ t: 'remove', parent: doc.root, node: snap });
    doc.apply({ t: 'insert', parent: doc.root, node: snap });
    expect(ids(doc.get('a').strokes)).toEqual(['s1']);
  });
});

describe('snapshot', () => {
  it('keeps sketches (v6) and reads older snapshots without them', () => {
    const { doc, ctx, run } = setup(['a', 'b']);
    run(() => drawStroke(ctx, 'a', line('s1', 'mark')));
    const json = serialize(doc);
    expect(JSON.parse(json).v).toBe(6);
    const copy = deserialize(json);
    checkInvariants(copy);
    expect(copy.get('a').strokes).toEqual([line('s1', 'mark')]);
    expect(copy.get('b').strokes).toBeUndefined();
    const v5 = deserialize(JSON.stringify({ v: 5, root: 'root', rows: [['x', -1, 'a0', 'x', 0, 0, 0, 0, '', 0, '']] }));
    expect(v5.get('x').strokes).toBeUndefined();
  });
});
