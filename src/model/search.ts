import { walkSnapshot, type Doc, type DocListener } from './doc';
import { splitTags, type TagIndex } from './tags';
import type { NodeId, Op } from './types';

/**
 * Case- and ё-insensitive form of a text. Same length as the input, so
 * offsets found in it apply to the original (for highlighting).
 */
export function normalize(text: string): string {
  let lower = text.toLowerCase();
  if (lower.length !== text.length) {
    // A few characters change length when lowercased (e.g. "İ"); keep those as is.
    lower = Array.from(text, (c) => {
      const l = c.toLowerCase();
      return l.length === c.length ? l : c;
    }).join('');
  }
  return lower.includes('ё') ? lower.replaceAll('ё', 'е') : lower;
}

export interface Query {
  /** Lowercased tags, from `#tag` tokens. */
  tags: string[];
  /** Normalized words and "quoted phrases"; all must occur in the bullet. */
  terms: string[];
}

const TOKEN = /"([^"]*)"|(\S+)/g;
const TAG_TOKEN = /^#([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)$/u;

export function parseQuery(text: string): Query {
  const tags = new Set<string>();
  const terms = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      if (m[1].trim()) terms.add(normalize(m[1]));
      continue;
    }
    const tag = TAG_TOKEN.exec(m[2]);
    if (tag) {
      tags.add(tag[1].toLowerCase());
      continue;
    }
    const word = m[2].replace(/^"+|"+$/g, ''); // a stray, unclosed quote
    if (word) terms.add(normalize(word));
  }
  return { tags: [...tags], terms: [...terms] };
}

export const isEmptyQuery = (q: Query) => !q.tags.length && !q.terms.length;

/**
 * Normalized text of every bullet, kept in sync by ops, so a search is a
 * single pass of `includes` over ready strings: no lowercasing per query.
 * Built lazily so it never slows down loading: in small slices while the
 * browser is idle (`warmUpInIdle`), and finished on the spot by a search
 * that comes earlier.
 */
export class TextIndex implements DocListener {
  private texts: Map<NodeId, string> | null = null;
  /** Bullets not normalized yet, while the build is in progress. */
  private pending: NodeId[] | null = null;
  private doc: Doc;
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    this.doc = doc;
    this.unsubscribe = doc.subscribe(this);
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Finishes building the index now. */
  warmUp(): Map<NodeId, string> {
    const texts = this.start();
    this.step(() => true);
    return texts;
  }

  /** Builds the index a slice at a time while the browser is idle. */
  warmUpInIdle(): void {
    if (typeof requestIdleCallback !== 'function') return;
    const tick = (deadline: IdleDeadline) => {
      this.start();
      this.step(() => deadline.timeRemaining() > 1);
      if (this.pending) requestIdleCallback(tick);
    };
    requestIdleCallback(tick);
  }

  private start(): Map<NodeId, string> {
    if (!this.texts) {
      this.texts = new Map();
      this.pending = [...this.doc.nodes.keys()].filter((id) => id !== this.doc.root);
    }
    return this.texts;
  }

  /** Normalizes pending bullets in batches while `more()` allows. Texts are read from the doc as it is now. */
  private step(more: () => boolean): void {
    const pending = this.pending;
    const texts = this.texts!;
    if (!pending) return;
    while (pending.length && more()) {
      for (let k = 0; k < 1000 && pending.length; k++) {
        const id = pending.pop()!;
        const n = this.doc.nodes.get(id);
        if (n) texts.set(id, normalize(n.text));
      }
    }
    if (!pending.length) this.pending = null;
  }

  /** Bullets containing every term; only those in `within`, if given. */
  find(terms: string[], within?: Iterable<NodeId>): Set<NodeId> {
    const texts = this.warmUp();
    const out = new Set<NodeId>();
    const matches = (t: string) => {
      for (const term of terms) if (!t.includes(term)) return false;
      return true;
    };
    if (within) {
      for (const id of within) {
        const t = texts.get(id);
        if (t !== undefined && matches(t)) out.add(id);
      }
    } else {
      for (const [id, t] of texts) if (matches(t)) out.add(id);
    }
    return out;
  }

  op(op: Op): void {
    // Not started yet: it will be built from the doc as it is then. Bullets
    // still pending get their current text when their turn comes.
    const texts = this.texts;
    if (!texts) return;
    switch (op.t) {
      case 'setText':
        texts.set(op.id, normalize(op.to));
        break;
      case 'insert':
        walkSnapshot(op.node, (s) => texts.set(s.id, normalize(s.text)));
        break;
      case 'remove':
        walkSnapshot(op.node, (s) => texts.delete(s.id));
        break;
    }
  }
}

/** Bullets matching every tag and every term of the query. */
export function findMatches(q: Query, tags: TagIndex, text: TextIndex): ReadonlySet<NodeId> {
  let within: Set<NodeId> | undefined;
  if (q.tags.length) {
    const sets = q.tags.map((t) => tags.nodesWith(t)).sort((a, b) => a.size - b.size);
    within = new Set();
    for (const id of sets[0]) if (sets.every((s) => s.has(id))) within.add(id);
  }
  if (!q.terms.length) return within ?? new Set();
  return text.find(q.terms, within);
}

export interface Piece {
  text: string;
  /** Lowercased tag name if this piece is (part of) a tag. */
  tag?: string;
  /** Part of a search hit. */
  hit?: true;
}

/** Splits text into pieces for display: tags, search hits, and plain text. */
export function decorate(text: string, terms: string[]): Piece[] {
  const segments = splitTags(text);
  if (!terms.length || !text) return segments;
  const norm = normalize(text);
  const hits: [number, number][] = [];
  for (const term of terms) {
    for (let i = norm.indexOf(term); i >= 0; i = norm.indexOf(term, i + 1)) hits.push([i, i + term.length]);
  }
  if (!hits.length) return segments;
  hits.sort((a, b) => a[0] - b[0]);
  const ranges: [number, number][] = [];
  for (const h of hits) {
    const last = ranges[ranges.length - 1];
    if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
    else ranges.push([h[0], h[1]]);
  }

  const out: Piece[] = [];
  let pos = 0;
  let r = 0;
  for (const s of segments) {
    const end = pos + s.text.length;
    for (let cur = pos; cur < end;) {
      while (r < ranges.length && ranges[r][1] <= cur) r++;
      const range = ranges[r];
      const hit = !!range && range[0] <= cur;
      const next = !range || range[0] >= end ? end : hit ? Math.min(range[1], end) : range[0];
      const piece: Piece = { text: text.slice(cur, next) };
      if (s.tag) piece.tag = s.tag;
      if (hit) piece.hit = true;
      out.push(piece);
      cur = next;
    }
    pos = end;
  }
  return out;
}
