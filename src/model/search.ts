import { walkSnapshot, type Doc, type DocListener } from './doc';
import { BOLD, ITALIC, LINK, LINK_RE, MARKER, formatFlags } from './format';
import { content, splitTags, tagKey, type TagIndex } from './tags';
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

/** One alternative of a query: everything in it must hold for a bullet. */
export interface Clause {
  /** Lowercased tags, from `#tag` tokens. */
  tags: string[];
  /** Normalized words and "quoted phrases"; all must occur in the bullet. */
  terms: string[];
  /** Excluded: `-#tag`. */
  notTags: string[];
  /** Excluded: `-word`, `-"phrase"`. */
  notTerms: string[];
  /** `is:task` / `is:todo` / `is:done`: only tasks / open tasks / completed tasks. */
  is: Kind[];
  /** The same negated: `-is:done` and so on. */
  notIs: Kind[];
}

/** What `is:` can ask about a bullet. */
export type Kind = 'task' | 'todo' | 'done';
const KINDS: readonly string[] = ['task', 'todo', 'done'];

function isKind(n: { todo: boolean; done: boolean }, kind: Kind): boolean {
  return kind === 'task' ? n.todo : kind === 'done' ? n.done : n.todo && !n.done;
}

export interface Query {
  /** Alternatives, joined by OR: a bullet matches if any one clause does. */
  clauses: Clause[];
  /** Every searched-for tag and term, across clauses: what gets highlighted. */
  tags: string[];
  terms: string[];
}

const TOKEN = /(-?)"([^"]*)"|(\S+)/g;
const TAG_TOKEN = /^([#@])([\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*)$/u;
const OR = /^(OR|ИЛИ|\|)$/;

const emptyClause = (): Clause => ({ tags: [], terms: [], notTags: [], notTerms: [], is: [], notIs: [] });
const isEmptyClause = (c: Clause) =>
  !c.tags.length && !c.terms.length && !c.notTags.length && !c.notTerms.length && !c.is.length && !c.notIs.length;

/**
 * Words, "phrases" and #tags must all occur; `-` before any of them excludes
 * it; `is:task`, `is:todo`, `is:done` keep only tasks, open tasks, completed
 * tasks (and `-is:…` the rest); `OR` (or
 * `ИЛИ`, `|`) separates alternatives.
 */
export function parseQuery(text: string): Query {
  const clauses: Clause[] = [];
  let clause = emptyClause();
  const add = <T extends string>(list: T[], value: T) => {
    if (value && !list.includes(value)) list.push(value);
  };
  for (const m of text.matchAll(TOKEN)) {
    if (m[2] !== undefined) {
      if (m[2].trim()) add(m[1] ? clause.notTerms : clause.terms, normalize(m[2]));
      continue;
    }
    const token = m[3];
    if (OR.test(token)) {
      if (!isEmptyClause(clause)) clauses.push(clause);
      clause = emptyClause();
      continue;
    }
    const negated = token.length > 1 && token.startsWith('-');
    const body = negated ? token.slice(1) : token;
    const kind = /^is:(\w+)$/i.exec(body)?.[1].toLowerCase();
    if (kind && KINDS.includes(kind)) {
      add(negated ? clause.notIs : clause.is, kind as Kind);
      continue;
    }
    const tag = TAG_TOKEN.exec(body);
    if (tag) {
      add(negated ? clause.notTags : clause.tags, tagKey(tag[1], tag[2]));
      continue;
    }
    const word = body.replace(/^"+|"+$/g, ''); // a stray, unclosed quote
    add(negated ? clause.notTerms : clause.terms, normalize(word));
  }
  if (!isEmptyClause(clause)) clauses.push(clause);
  return {
    clauses,
    tags: [...new Set(clauses.flatMap((c) => c.tags))],
    terms: [...new Set(clauses.flatMap((c) => c.terms))],
  };
}

export const isEmptyQuery = (q: Query) => !q.clauses.length;

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
  /** Bullets deleted (moved to the trash) while the build is in progress: skipped when their turn comes. */
  private excluded: Set<NodeId> | null = null;
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
      this.pending = [];
      this.doc.walk(this.doc.root, (n) => n.id !== this.doc.root && this.pending!.push(n.id));
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
        if (n && !this.excluded?.has(id)) texts.set(id, normalize(content(n)));
      }
    }
    if (!pending.length) this.pending = this.excluded = null;
  }

  /** Every bullet. */
  ids(): Iterable<NodeId> {
    return this.warmUp().keys();
  }

  /** Every bullet with its normalized text and note. */
  entries(): Iterable<[NodeId, string]> {
    return this.warmUp();
  }

  /** A bullet's normalized text and note. */
  textOf(id: NodeId): string {
    return this.warmUp().get(id) ?? '';
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

  op(op: Op, doc: Doc): void {
    // Not started yet: it will be built from the doc as it is then. Bullets
    // still pending get their current text when their turn comes.
    const texts = this.texts;
    if (!texts) return;
    switch (op.t) {
      case 'setText':
      case 'setNote':
        if (doc.inOutline(op.id)) texts.set(op.id, normalize(content(doc.get(op.id))));
        break;
      case 'insert':
        if (doc.inOutline(op.parent)) walkSnapshot(op.node, (s) => texts.set(s.id, normalize(content(s))));
        break;
      case 'remove':
        walkSnapshot(op.node, (s) => texts.delete(s.id));
        break;
      case 'move': {
        // Across the trash boundary: the subtree enters or leaves the index.
        const now = doc.inOutline(op.to.parent);
        if (now === doc.inOutline(op.from.parent)) break;
        const excluded = this.pending ? (this.excluded ??= new Set()) : null;
        doc.walk(op.id, (n) => {
          if (now) {
            texts.set(n.id, normalize(content(n)));
            excluded?.delete(n.id);
          } else {
            texts.delete(n.id);
            excluded?.add(n.id);
          }
        });
        break;
      }
    }
  }
}

/**
 * Bullets matching the query: any clause, each with all its tags and terms,
 * none of its exclusions. A tag matches by its start, as a word does
 * (`TagIndex.nodesWithPrefix`). Tags narrow first (from the tag index), so words
 * are only checked in tagged bullets; a clause of exclusions alone scans all.
 */
export function findMatches(q: Query, tags: TagIndex, text: TextIndex, doc: Doc): ReadonlySet<NodeId> {
  const out = new Set<NodeId>();
  for (const c of q.clauses) {
    let candidates: Iterable<NodeId>;
    if (c.tags.length) {
      const sets = c.tags.map((t) => tags.nodesWithPrefix(t)).sort((a, b) => a.size - b.size);
      const within = new Set<NodeId>();
      for (const id of sets[0]) if (sets.every((s) => s.has(id))) within.add(id);
      candidates = c.terms.length ? text.find(c.terms, within) : within;
    } else {
      candidates = c.terms.length ? text.find(c.terms) : text.ids();
    }
    const excluded = c.notTags.map((t) => tags.nodesWithPrefix(t));
    for (const id of candidates) {
      if (excluded.some((s) => s.has(id))) continue;
      if (c.is.length || c.notIs.length) {
        const n = doc.get(id);
        if (!c.is.every((k) => isKind(n, k)) || c.notIs.some((k) => isKind(n, k))) continue;
      }
      if (c.notTerms.length) {
        const t = text.textOf(id);
        if (c.notTerms.some((term) => t.includes(term))) continue;
      }
      out.add(id);
    }
  }
  return out;
}

export interface Piece {
  text: string;
  /** Lowercased tag name if this piece is (part of) a tag. */
  tag?: string;
  /** Part of a search hit. */
  hit?: true;
  /** Inside `**bold**` or `*italic*` (model/format.ts). */
  bold?: true;
  italic?: true;
  /** A formatting marker itself: hidden in the static view. */
  marker?: true;
  /** Part of a `[[link]]` (model/links.ts): the title it leads to. Tags inside a link are just text. */
  link?: string;
}

const HIT = 16;

/** Splits text into pieces for display: tags, search hits, bold, italic, formatting markers, plain text. */
export function decorate(text: string, terms: string[]): Piece[] {
  const segments = splitTags(text);
  const flags = formatFlags(text);
  let marks = flags;
  if (terms.length && text) {
    const norm = normalize(text);
    for (const term of terms) {
      for (let i = norm.indexOf(term); i >= 0; i = norm.indexOf(term, i + 1)) {
        marks ??= new Uint8Array(text.length);
        for (let k = i; k < i + term.length; k++) marks[k] |= HIT;
      }
    }
  }
  if (!marks) return segments;

  // Within each tag or plain segment, a new piece wherever the marks change.
  const out: Piece[] = [];
  const links = flags && text.includes('[[') ? [...text.matchAll(LINK_RE)] : [];
  let link = 0;
  let pos = 0;
  for (const s of segments) {
    const end = pos + s.text.length;
    for (let cur = pos; cur < end;) {
      const m = marks[cur];
      let next = cur + 1;
      while (next < end && marks[next] === m) next++;
      const piece: Piece = { text: text.slice(cur, next) };
      if (m & LINK) {
        while (links[link].index + links[link][0].length <= cur) link++;
        piece.link = links[link][1];
      } else if (s.tag) piece.tag = s.tag;
      if (m & HIT) piece.hit = true;
      if (m & MARKER) piece.marker = true;
      else {
        if (m & BOLD) piece.bold = true;
        if (m & ITALIC) piece.italic = true;
      }
      out.push(piece);
      cur = next;
    }
    pos = end;
  }
  return out;
}
