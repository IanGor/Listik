/** Prefix sums over row heights: O(log n) point update, prefix query and offset search. */
export class Fenwick {
  private t = new Float64Array(1);
  private n = 0;

  get size(): number {
    return this.n;
  }

  build(values: ArrayLike<number>): void {
    const n = values.length;
    if (this.t.length < n + 1) this.t = new Float64Array(Math.max(n + 1, this.t.length * 2));
    else this.t.fill(0, 0, n + 1);
    this.n = n;
    const t = this.t;
    for (let i = 1; i <= n; i++) {
      t[i] += values[i - 1];
      const j = i + (i & -i);
      if (j <= n) t[j] += t[i];
    }
  }

  add(i: number, delta: number): void {
    for (i++; i <= this.n; i += i & -i) this.t[i] += delta;
  }

  /** Sum of values [0, i). */
  prefix(i: number): number {
    let s = 0;
    for (; i > 0; i -= i & -i) s += this.t[i];
    return s;
  }

  total(): number {
    return this.prefix(this.n);
  }

  /** Index whose span [prefix(i), prefix(i + 1)) contains `y`, clamped to [0, size - 1]. */
  find(y: number): number {
    let pos = 0;
    let step = 1;
    while (step * 2 <= this.n) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.n && this.t[next] <= y) {
        pos = next;
        y -= this.t[next];
      }
    }
    return Math.min(pos, Math.max(0, this.n - 1));
  }
}
