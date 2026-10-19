import { walkSnapshot, type Doc, type DocListener } from './doc';
import type { NodeId, Op } from './types';

/**
 * `#tag` or `@tag` at the start of the text or after whitespace / "(".
 * Letters, digits and `_` in any script, with inner hyphens:
 * `#война-и-мир`. So "a#b", "a@mail.ru" and "#tag-" (trailing hyphen) are
 * not tags, or not entirely. The two sigils are two sets of tags that work
 * alike, for telling kinds of things apart: `#работа` and `@работа` differ.
 */
const TAG = /(?<=^|[\s(])([#@])([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)/gu;

/** The sigils a tag starts with. */
export type Sigil = '#' | '@';

/**
 * A tag's key in the index and in queries, lowercased: `#name` is "name",
 * as it always was, `@name` is "@name".
 */
export const tagKey = (sigil: string, name: string): string => (sigil === '@' ? '@' : '') + name.toLowerCase();

/** How a tag key is written in text: "name" is `#name`, "@name" stays. */
export const tagText = (key: string): string => (key.startsWith('@') ? key : `#${key}`);

const mayHaveTags = (text: string) => text.includes('#') || text.includes('@');

export interface Segment {
  text: string;
  /** The tag's key (tagKey) if this segment is a tag. */
  tag?: string;
}

/** Splits text into plain and tag segments, for highlighting. */
export function splitTags(text: string): Segment[] {
  if (!mayHaveTags(text)) return text ? [{ text }] : [];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], tag: tagKey(m[1], m[2]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Distinct tag keys of a text. */
export function parseTags(text: string): string[] {
  if (!mayHaveTags(text)) return [];
  const tags = new Set<string>();
  for (const m of text.matchAll(TAG)) tags.add(tagKey(m[1], m[2]));
  return [...tags];
}

const NONE: readonly string[] = [];

/** What tags and search read: the bullet's text and its note. */
export const content = (n: { text: string; note: string }) => (n.note ? `${n.text}\n${n.note}` : n.text);
const EMPTY: ReadonlySet<NodeId> = new Set();

/**
 * Tag → bullets that carry it. Built once in a single pass, then kept in
 * sync by ops: editing a bullet costs only re-parsing that bullet's text.
 * Bullets in the trash are not indexed; a move across the trash boundary
 * indexes or drops the whole subtree.
 */
export class TagIndex implements DocListener {
  private byTag = new Map<string, Set<NodeId>>();
  private byNode = new Map<NodeId, readonly string[]>();
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    doc.walk(doc.root, (n) => this.set(n.id, content(n)));
    this.unsubscribe = doc.subscribe(this);
  }

  dispose(): void {
    this.unsubscribe();
  }

  nodesWith(tag: string): ReadonlySet<NodeId> {
    return this.byTag.get(tag.toLowerCase()) ?? EMPTY;
  }

  /**
   * Bullets with a tag that starts with `prefix`: a tag in the search box
   * narrows with every character typed, like a word (`#n` finds #next and
   * #note, `#ne` only #next). `#` and `@` tags stay apart: an `@` tag's key
   * starts with `@`.
   */
  nodesWithPrefix(prefix: string): ReadonlySet<NodeId> {
    const p = prefix.toLowerCase();
    let first: ReadonlySet<NodeId> | null = null;
    let union: Set<NodeId> | null = null;
    for (const [tag, ids] of this.byTag) {
      if (!tag.startsWith(p)) continue;
      if (!first) {
        first = ids;
        continue;
      }
      union ??= new Set(first);
      for (const id of ids) union.add(id);
    }
    return union ?? first ?? EMPTY;
  }

  /** All tags with their bullet counts. */
  counts(): Map<string, number> {
    return new Map([...this.byTag].map(([tag, ids]) => [tag, ids.size]));
  }

  /** The same, without building a map: completion reads it on every keystroke. */
  *entries(): IterableIterator<[tag: string, count: number]> {
    for (const [tag, ids] of this.byTag) yield [tag, ids.size];
  }

  op(op: Op, doc: Doc): void {
    switch (op.t) {
      case 'setText':
      case 'setNote':
        if (doc.inOutline(op.id)) this.set(op.id, content(doc.get(op.id)));
        break;
      case 'insert':
        if (doc.inOutline(op.parent)) walkSnapshot(op.node, (s) => this.set(s.id, content(s)));
        break;
      case 'remove':
        walkSnapshot(op.node, (s) => this.set(s.id, ''));
        break;
      case 'move': {
        const now = doc.inOutline(op.to.parent);
        if (now === doc.inOutline(op.from.parent)) break;
        doc.walk(op.id, (n) => this.set(n.id, now ? content(n) : ''));
        break;
      }
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
