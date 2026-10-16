import type { Doc, DocListener } from './doc';
import type { NodeId, NodeSnapshot, Op } from './types';

/**
 * `#tag` at the start of the text or after whitespace / "(". Letters, digits
 * and `_` in any script, with inner hyphens: `#война-и-мир`. So "a#b" and
 * "#tag-" (trailing hyphen) are not tags, or not entirely.
 */
const TAG = /(?<=^|[\s(])#([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)/gu;

export interface Segment {
  text: string;
  /** Lowercased tag name if this segment is a tag. */
  tag?: string;
}

/** Splits text into plain and tag segments, for highlighting. */
export function splitTags(text: string): Segment[] {
  if (!text.includes('#')) return text ? [{ text }] : [];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], tag: m[1].toLowerCase() });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Distinct lowercased tags of a text. */
export function parseTags(text: string): string[] {
  if (!text.includes('#')) return [];
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG)) tags.add(m[1].toLowerCase());
  return [...tags];
}

const NONE: readonly string[] = [];
const EMPTY: ReadonlySet<NodeId> = new Set();

/**
 * Tag → bullets that carry it. Built once in a single pass, then kept in
 * sync by ops: editing a bullet costs only re-parsing that bullet's text.
 */
export class TagIndex implements DocListener {
  private byTag = new Map<string, Set<NodeId>>();
  private byNode = new Map<NodeId, readonly string[]>();
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    for (const n of doc.nodes.values()) this.set(n.id, n.text);
    this.unsubscribe = doc.subscribe(this);
  }

  dispose(): void {
    this.unsubscribe();
  }

  nodesWith(tag: string): ReadonlySet<NodeId> {
    return this.byTag.get(tag.toLowerCase()) ?? EMPTY;
  }

  /** All tags with their bullet counts. */
  counts(): Map<string, number> {
    return new Map([...this.byTag].map(([tag, ids]) => [tag, ids.size]));
  }

  op(op: Op): void {
    switch (op.t) {
      case 'setText':
        this.set(op.id, op.to);
        break;
      case 'insert':
        walk(op.node, (s) => this.set(s.id, s.text));
        break;
      case 'remove':
        walk(op.node, (s) => this.set(s.id, ''));
        break;
    }
  }

  private set(id: NodeId, text: string): void {
    const prev = this.byNode.get(id) ?? NONE;
    const next = parseTags(text);
    if (prev.length === next.length && prev.every((t, i) => t === next[i])) return;
    for (const t of prev) {
      if (next.includes(t)) continue;
      const ids = this.byTag.get(t)!;
      ids.delete(id);
      if (!ids.size) this.byTag.delete(t);
    }
    for (const t of next) {
      if (prev.includes(t)) continue;
      let ids = this.byTag.get(t);
      if (!ids) this.byTag.set(t, (ids = new Set()));
      ids.add(id);
    }
    if (next.length) this.byNode.set(id, next);
    else this.byNode.delete(id);
  }
}

function walk(root: NodeSnapshot, fn: (s: NodeSnapshot) => void): void {
  const stack = [root];
  while (stack.length) {
    const s = stack.pop()!;
    fn(s);
    for (const c of s.children) stack.push(c);
  }
}
