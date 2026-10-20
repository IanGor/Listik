import type { Doc } from './doc';
import { own } from '../util/own';
import type { NodeId } from './types';

/** A bullet with its children, outside any document: what import, export and paste exchange. */
export interface Tree {
  text: string;
  note?: string;
  /** A task: `- [ ]`, or `- [x]` when done. */
  todo?: boolean;
  done?: boolean;
  /** Folded (the structure's quarters, the calendar's days); import and export leave it out. */
  collapsed?: boolean;
  children: Tree[];
}

export function countTrees(trees: Tree[]): number {
  let n = 0;
  const stack = [...trees];
  while (stack.length) {
    const t = stack.pop()!;
    n++;
    for (const c of t.children) stack.push(c);
  }
  return n;
}

const MARKER = /^(?:[-*+•]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s+/;
const CHECKBOX = /^\[([ xX])\]\s+/;

/**
 * Indented text → trees: Markdown lists, Workflowy's plain-text export, or
 * any text indented by a consistent amount of spaces or tabs (a tab counts
 * as 4). A line indented deeper than the one before becomes its child. List
 * markers (-, *, +, •, 1.) and heading marks are dropped; `#tag` stays (a
 * heading mark needs a space after the #). Blank lines are skipped.
 *
 * In a list (items with markers), `- [x] item` is a completed item, and a
 * line without a marker indented under an item continues that item's note:
 * the way `toMarkdown` writes them.
 */
export function parseIndented(text: string): Tree[] {
  const roots: Tree[] = [];
  const stack: { indent: number; node: Tree; listed: boolean }[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    let indent = 0;
    for (const c of lead) indent += c === '\t' ? 4 : 1;
    let body = line.slice(lead.length).trimEnd();
    const marker = MARKER.exec(body);
    const last = stack[stack.length - 1];
    if (!marker && last?.listed && indent > last.indent && !HEADING.test(body)) {
      last.node.note = last.node.note ? `${last.node.note}\n${body}` : own(body);
      continue;
    }
    body = marker ? body.slice(marker[0].length) : body.replace(HEADING, '');
    const node: Tree = { text: own(body), children: [] };
    const box = marker && CHECKBOX.exec(body);
    if (box) {
      node.text = own(body.slice(box[0].length));
      node.todo = true;
      if (box[1] !== ' ') node.done = true;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node, listed: !!marker });
  }
  return roots;
}

/** Visits `starts` and their subtrees in pre-order; the starts are at depth 0. */
function walk(doc: Doc, starts: NodeId[], fn: (id: NodeId, depth: number) => void): void {
  const stack: [NodeId, number][] = [];
  const push = (ids: NodeId[], depth: number) => {
    for (let k = ids.length - 1; k >= 0; k--) stack.push([ids[k], depth]);
  };
  push(starts, 0);
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    fn(id, depth);
    push(doc.get(id).children, depth + 1);
  }
}

/**
 * A Markdown list, two spaces per level; completed items as `- [x]`, note
 * lines under their item at the text's indent. Reads back with `parseIndented`.
 */
export function toMarkdown(doc: Doc, root: NodeId = doc.root): string {
  return markdownOf(doc, doc.get(root).children);
}

/** The given bullets with their subtrees, as a Markdown list (copying a selection). */
export function markdownOf(doc: Doc, ids: NodeId[]): string {
  const out: string[] = [];
  walk(doc, ids, (id, depth) => {
    const n = doc.content(id); // a mirror exports as a copy of its original
    const pad = '  '.repeat(depth);
    out.push(`${pad}- ${n.todo || n.done ? (n.done ? '[x] ' : '[ ] ') : ''}${n.text}`);
    if (n.note) for (const line of n.note.split('\n')) out.push(line.trim() ? `${pad}  ${line}` : '');
  });
  return out.length ? `${out.join('\n')}\n` : '';
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** OPML 2.0, the outline exchange format Workflowy and other outliners read (with its `_note`, `_complete`). */
export function toOpml(doc: Doc, title = 'Listik'): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${escapeXml(title)}</title></head>`,
    '  <body>',
  ];
  const emit = (id: NodeId, depth: number) => {
    const n = doc.content(id); // a mirror exports as a copy of its original
    const pad = '  '.repeat(depth + 2);
    const extra = (n.note ? ` _note="${escapeXml(n.note)}"` : '') + (n.todo ? ' _task="true"' : '') + (n.done ? ' _complete="true"' : '');
    const open = `${pad}<outline text="${escapeXml(n.text)}"${extra}`;
    if (!n.children.length) return out.push(`${open} />`);
    out.push(`${open}>`);
    for (const c of n.children) emit(c, depth + 1);
    out.push(`${pad}</outline>`);
  };
  for (const c of doc.get(doc.root).children) emit(c, 0);
  out.push('  </body>', '</opml>');
  return `${out.join('\n')}\n`;
}

export function looksLikeOpml(text: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?<opml[\s>]/i.test(text);
}

/** OPML → trees; needs a DOMParser (the browser's). */
export function parseOpml(xml: string): Tree[] {
  const dom = new DOMParser().parseFromString(xml, 'text/xml');
  const body = dom.querySelector('opml > body');
  if (dom.querySelector('parsererror') || !body) throw new Error('Файл не похож на OPML');
  const read = (el: Element): Tree[] =>
    Array.from(el.children)
      .filter((c) => c.tagName.toLowerCase() === 'outline')
      .map((c) => {
        const tree: Tree = { text: (c.getAttribute('text') ?? '').replace(/\s*\n\s*/g, ' '), children: read(c) };
        const note = c.getAttribute('_note');
        if (note) tree.note = note;
        if (c.getAttribute('_task') === 'true') tree.todo = true;
        // Workflowy has no tasks: a completed item becomes a completed task.
        if (c.getAttribute('_complete') === 'true') tree.todo = tree.done = true;
        return tree;
      });
  return read(body);
}
