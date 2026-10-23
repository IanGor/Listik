import { walkSnapshot, type Doc, type DocListener } from './doc';
import type { NodeId, Op, OutlineNode } from './types';

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
 * The tag that hides a bullet with all that is inside it from search, the
 * tag filter, tag suggestions, links, mirrors and the places line: found
 * only by going there through the outline itself.
 */
export const SECRET = 'secret';

const SECRET_TEXT = /#secret/i;

/** Does a bullet's text and note carry `#secret`? Checked for every bullet on load: most have no `#` at all. */
export const isSecret = (n: { text: string; note: string }): boolean => {
  const text = content(n);
  return text.includes('#') && SECRET_TEXT.test(text) && parseTags(text).includes(SECRET);
};

/** Is the bullet in the outline (not the trash) with no `#secret` on it or above it: one that search sees? */
export function searchable(doc: Doc, id: NodeId): boolean {
  for (let p: NodeId | null = id; p !== null; p = doc.get(p).parent) {
    if (p === doc.root) return true;
    if (isSecret(doc.get(p))) return false;
  }
  return false;
}

type Seen = { id: NodeId; text: string; note: string };

/** Visits `id` and all inside it that search sees from there: a `#secret` bullet is skipped with its subtree. */
export function walkSearchable(doc: Doc, id: NodeId, fn: (n: OutlineNode) => void): void {
  const stack = [id];
  while (stack.length) {
    const n = doc.get(stack.pop()!);
    if (isSecret(n)) continue;
    fn(n);
    for (const c of n.children) stack.push(c);
  }
}

/**
 * How an op changes what search sees, for the indexes built on it:
 * `show` a bullet seen now (with its current text and note), `hide` one
 * not seen anymore. A bullet is seen while it is in the outline and has
 * no `#secret` on it or above it (`searchable`): crossing the trash
 * boundary, moving into or out of a secret bullet, or `#secret` typed or
 * erased shows or hides a whole subtree.
 */
export function searchChanges(op: Op, doc: Doc, show: (n: Seen) => void, hide: (id: NodeId) => void): void {
  switch (op.t) {
    case 'setText':
    case 'setNote': {
      const n = doc.get(op.id);
      if (n.parent === null || !searchable(doc, n.parent)) return;
      const was = isSecret(op.t === 'setText' ? { text: op.from, note: n.note } : { text: n.text, note: op.from });
      const now = isSecret(n);
      if (now) {
        if (!was) doc.walk(op.id, (d) => hide(d.id));
      } else if (was) walkSearchable(doc, op.id, show);
      else show(n);
      return;
    }
    case 'insert':
      if (searchable(doc, op.parent)) {
        const stack = [op.node];
        while (stack.length) {
          const s = stack.pop()!;
          if (isSecret(s)) continue;
          show(s);
          for (const c of s.children) stack.push(c);
        }
      }
      return;
    case 'remove':
      walkSnapshot(op.node, (s) => hide(s.id));
      return;
    case 'move': {
      const now = searchable(doc, op.to.parent);
      if (now === searchable(doc, op.from.parent)) return;
      if (now) walkSearchable(doc, op.id, show);
      else doc.walk(op.id, (n) => hide(n.id));
      return;
    }
  }
}

/**
 * Tag → bullets that carry it. Built once in a single pass, then kept in
 * sync by ops: editing a bullet costs only re-parsing that bullet's text.
 * Bullets in the trash and `#secret` ones with their insides are not
 * indexed (`searchChanges`), so `#secret` itself is never offered or found.
 */
export class TagIndex implements DocListener {
  private byTag = new Map<string, Set<NodeId>>();
  private byNode = new Map<NodeId, readonly string[]>();
  private unsubscribe: () => void;

  constructor(doc: Doc) {
    walkSearchable(doc, doc.root, (n) => this.set(n.id, content(n)));
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
    searchChanges(op, doc, (n) => this.set(n.id, content(n)), (id) => this.set(id, ''));
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
