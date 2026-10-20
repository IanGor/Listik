import { placeTrees, setNote, setText, type Ctx } from './commands';
import type { Doc } from './doc';
import { plainText } from './format';
import { compareOrder } from './links';
import type { Tree } from './outline-text';
import { nodeOf, type RowKey } from './rows';
import { parseTags, type TagIndex } from './tags';
import type { Focus, NodeId } from './types';

/**
 * Templates: a bullet tagged `#template` is one, with everything inside it;
 * its name is its text without the tag. `/template` in any bullet (or `/`
 * and a few letters of a name, view/Suggest.tsx) offers them, and what is
 * inside the one taken comes in as a copy, at the bullet's level: from the
 * bullet itself if it holds nothing else, otherwise after it.
 */

export const TEMPLATE_TAG = 'template';

const TAG_TEXT = /(^|\s)#template(?![\p{L}\p{N}_-])/giu;

/** A template's name: its bullet's text without `#template`, as it reads. */
export function templateTitle(text: string): string {
  return plainText(text.replace(TAG_TEXT, '$1')).replace(/\s+/g, ' ').trim();
}

export interface Template {
  id: NodeId;
  title: string;
}

/** The templates in the outline, in document order: bullets whose own text carries `#template`. */
export function findTemplates(doc: Doc, tags: TagIndex): Template[] {
  const ids = [...tags.nodesWith(TEMPLATE_TAG)].filter((id) => {
    const n = doc.nodes.get(id);
    return !!n && !n.mirrorOf && doc.inOutline(id) && parseTags(n.text).includes(TEMPLATE_TAG);
  });
  return ids.sort((a, b) => compareOrder(doc, a, b)).map((id) => ({ id, title: templateTitle(doc.get(id).text) || 'Без названия' }));
}

/**
 * The template as new bullets: its name for the text, its note, task and
 * everything inside it (a mirror inside reads as a copy of what it shows),
 * every task unchecked.
 */
export function templateTree(doc: Doc, id: NodeId): Tree {
  const copy = (n: NodeId, top: boolean): Tree => {
    const c = doc.content(n);
    return {
      text: top ? templateTitle(c.text) : c.text,
      note: c.note,
      todo: c.todo,
      children: (doc.host(n)?.children ?? []).map((k) => copy(k, false)),
    };
  };
  return copy(id, true);
}

/**
 * A template taken from the suggestions, its `/template…` token at
 * [start, end) of the row's text: what is inside the template comes in at
 * the row's level, without the template's own bullet (its name and tag).
 * An empty row (no other text, note or bullets) takes the first of them,
 * the rest following it; otherwise they all come in after the row. The
 * caret goes to the end of the first. A template with nothing inside only
 * loses its token: null then.
 */
export function insertTemplate(ctx: Ctx, key: RowKey, template: NodeId, start: number, end: number): Focus | null {
  const { doc } = ctx;
  if (!doc.has(template)) return null;
  const id = nodeOf(key);
  const trees = templateTree(doc, template).children;
  const c = doc.content(id);
  const host = doc.host(id);
  const rest = c.text.slice(0, start) + c.text.slice(end);
  const parent = doc.get(id).parent!;
  const after = doc.index(id) + 1;
  if (!trees.length) {
    setText(ctx, key, rest);
    return null;
  }
  if (host && !rest.trim() && !c.note && !host.children.length) {
    const [first, ...others] = trees;
    setText(ctx, key, first.text);
    if (first.note) setNote(ctx, key, first.note);
    if (first.todo && !c.todo) doc.apply({ t: 'setTodo', id: c.id, from: false, to: true });
    placeTrees(ctx, host.id, 0, first.children);
    placeTrees(ctx, parent, after, others);
    return { id: key, caret: first.text.length };
  }
  setText(ctx, key, rest);
  const made = placeTrees(ctx, parent, after, trees) as Focus;
  return { id: made.id, caret: trees[0].text.length };
}

/**
 * The templates to offer for `/` and what follows it: all of them while it
 * may still become `/template` (`/`, `/t`, `/temp`), those whose name holds
 * what follows `/template`, or else those whose name holds the query (`/встр`).
 */
export function matchTemplates(templates: readonly Template[], query: string, limit: number): Template[] {
  const q = query.toLowerCase();
  const name = TEMPLATE_TAG.startsWith(q) ? '' : q.startsWith(TEMPLATE_TAG) ? q.slice(TEMPLATE_TAG.length) : q;
  return templates.filter((t) => t.title.toLowerCase().includes(name)).slice(0, limit);
}

/** Is the query on its way to `/template` (two letters at least): with no templates, say how to make one. */
export const asksTemplate = (query: string) => {
  const q = query.toLowerCase();
  return (q.length >= 2 && TEMPLATE_TAG.startsWith(q)) || q.startsWith(TEMPLATE_TAG);
};
