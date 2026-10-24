import { nanoid } from 'nanoid';
import type { Ctx } from './commands';
import type { NodeId, Stroke } from './types';

/**
 * A bullet's sketch: lines drawn on a sheet beside its zoomed-in list
 * (view/Sketch.tsx). The sheet is SHEET units wide whatever the screen, so a
 * drawing looks the same everywhere, and runs down without end. Lines are
 * added and erased whole (ops `addStrokes`/`removeStrokes`), by id, so two
 * devices drawing at once never clash.
 */
export const SHEET = 1000;

export type Point = [x: number, y: number];

/** Points are stored at half-unit precision: plenty for a 1000-unit sheet. */
const PRECISION = 2;

/** Points as text: the first one, then each as a step from the one before, in half units. */
export function encodePoints(points: Point[]): string {
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of points) {
    const qx = Math.round(x * PRECISION);
    const qy = Math.round(y * PRECISION);
    out.push(qx - px, qy - py);
    px = qx;
    py = qy;
  }
  return out.join(' ');
}

export function decodePoints(d: string): Point[] {
  const nums = d ? d.split(' ').map(Number) : [];
  const out: Point[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    x += nums[i];
    y += nums[i + 1];
    out.push([x / PRECISION, y / PRECISION]);
  }
  return out;
}

/** Drops points that keep within `tolerance` of the line through their neighbours (Ramer–Douglas–Peucker). */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let max = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > max) {
        max = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return points.filter((_, i) => keep[i]);
}

/** Distance from `p` to the segment a–b. */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Does the line pass within `radius` of `p`? */
export function touches(points: Point[], p: Point, radius: number): boolean {
  if (points.length === 1) return Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) <= radius;
  for (let i = 1; i < points.length; i++) if (segmentDistance(p, points[i - 1], points[i]) <= radius) return true;
  return false;
}

/** SVG path data: a smooth curve through the midpoints, so a line drawn by hand has no corners. */
export function pathData(points: Point[]): string {
  if (!points.length) return '';
  const f = (n: number) => String(Math.round(n * 10) / 10);
  const [x0, y0] = points[0];
  // A dot: a zero-length line, which round caps draw as a dot.
  if (points.length === 1) return `M${f(x0)} ${f(y0)}l0 0`;
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [xl, yl] = points[points.length - 1];
  return `${d}L${f(xl)} ${f(yl)}`;
}

/** A new line for a sketch. */
export function newStroke(tool: Stroke['tool'], points: Point[]): Stroke {
  return { id: nanoid(10), tool, d: encodePoints(points) };
}

/** Draws on the sketch of the bullet the row `id` shows (a mirror's is its original's). */
export function drawStroke({ doc }: Ctx, id: NodeId, stroke: Stroke): void {
  doc.apply({ t: 'addStrokes', id: doc.content(id).id, strokes: [stroke] });
}

/** Erases lines from the sketch of the bullet the row `id` shows. */
export function eraseStrokes({ doc }: Ctx, id: NodeId, ids: ReadonlySet<string>): void {
  const n = doc.content(id);
  const strokes = n.strokes?.filter((s) => ids.has(s.id)) ?? [];
  if (strokes.length) doc.apply({ t: 'removeStrokes', id: n.id, strokes });
}
