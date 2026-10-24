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

/** A turn sharper than this, within a few `sigma` of the line, is a corner the smoothing keeps, degrees. */
const CORNER = 70;

/**
 * Takes the tremor out of a line drawn by hand without changing its shape:
 * each point moves to a Gaussian-weighted average of its neighbours along
 * the line (by distance drawn, not by point count, so a slow stroke with
 * many points smooths like a fast one). Sharp corners (к, м, the tip of an
 * arrow) and the ends stay where they were: the line is smoothed piece by
 * piece between them, each piece easing in from its fixed ends. `sigma` is
 * in sheet units; 0 leaves the line as it was.
 */
export function smooth(points: Point[], sigma: number): Point[] {
  const n = points.length;
  if (n < 3 || sigma <= 0) return points;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  // Corners: where the way in and the way out, each 2σ long, turn more than CORNER.
  const reach = 2 * sigma;
  const cos = Math.cos((CORNER * Math.PI) / 180);
  const breaks = [0];
  let back = 0;
  let ahead = 0;
  // Points near a corner all turn sharply: the sharpest of each such run is the corner.
  let best = -1;
  let bestCos = 1;
  for (let i = 1; i < n - 1; i++) {
    while (back < i && s[i] - s[back + 1] >= reach) back++;
    while (ahead < n - 1 && s[ahead] - s[i] < reach) ahead++;
    const ax = points[i][0] - points[back][0];
    const ay = points[i][1] - points[back][1];
    const bx = points[ahead][0] - points[i][0];
    const by = points[ahead][1] - points[i][1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const c = la < sigma || lb < sigma ? 1 : (ax * bx + ay * by) / (la * lb);
    if (c < cos) {
      if (c < bestCos) {
        best = i;
        bestCos = c;
      }
    } else if (best >= 0) {
      breaks.push(best);
      best = -1;
      bestCos = 1;
    }
  }
  if (best >= 0) breaks.push(best);
  breaks.push(n - 1);
  const out: Point[] = points.map((p) => [p[0], p[1]]);
  const window = 3 * sigma;
  const k = -1 / (2 * sigma * sigma);
  for (let b = 0; b + 1 < breaks.length; b++) {
    const from = breaks[b];
    const to = breaks[b + 1];
    let lo = from;
    let hi = from;
    for (let i = from + 1; i < to; i++) {
      while (s[i] - s[lo] > window) lo++;
      while (hi < to && s[hi + 1] - s[i] <= window) hi++;
      let w = 0;
      let x = 0;
      let y = 0;
      for (let j = lo; j <= hi; j++) {
        const d = s[j] - s[i];
        const g = Math.exp(d * d * k);
        w += g;
        x += g * points[j][0];
        y += g * points[j][1];
      }
      // Near a fixed end the window is lopsided: ease in so the end does not pull the line short.
      const t = Math.min(1, (s[i] - s[from]) / window, (s[to] - s[i]) / window);
      out[i] = [points[i][0] + (x / w - points[i][0]) * t, points[i][1] + (y / w - points[i][1]) * t];
    }
  }
  return out;
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

/**
 * SVG path data: a curve through every point Apple Pencil gave (centripetal
 * Catmull–Rom, as cubic Béziers). It keeps small handwriting in shape, where
 * a curve between the points' midpoints cut its turns into a broken line,
 * and makes no loops or cusps at a sharp turn.
 */
export function pathData(points: Point[]): string {
  if (!points.length) return '';
  const f = (n: number) => String(Math.round(n * 100) / 100);
  const [x0, y0] = points[0];
  // A dot: a zero-length line, which round caps draw as a dot.
  if (points.length === 1) return `M${f(x0)} ${f(y0)}l0 0`;
  let d = `M${f(x0)} ${f(y0)}`;
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    // Knot spacing: the square root of each step's length (centripetal).
    const d1 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
    const d2 = Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
    const d3 = Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
    const c1 = d1 < 1e-6 ? p1 : control(p0, p1, p2, d1, d2);
    const c2 = d3 < 1e-6 ? p2 : control(p3, p2, p1, d3, d2);
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/** The Bézier control point next to `b` on the way to `c`, `a` being the point before `b`. */
function control(a: Point, b: Point, c: Point, da: number, db: number): Point {
  const a2 = da * da;
  const b2 = db * db;
  const m = 2 * a2 + 3 * da * db + b2;
  const k = 3 * da * (da + db);
  return [(a2 * c[0] - b2 * a[0] + m * b[0]) / k, (a2 * c[1] - b2 * a[1] + m * b[1]) / k];
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
