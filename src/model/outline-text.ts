import type { Doc } from './doc';
import type { NodeId } from './types';

/** A bullet with its children, outside any document: what import, export and paste exchange. */
export interface Tree {
  text: string;
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

/**
 * Indented text → trees: Markdown lists, Workflowy's plain-text export, or
 * any text indented by a consistent amount of spaces or tabs (a tab counts
 * as 4). A line indented deeper than the one before becomes its child. List
 * markers (-, *, +, •, 1.) and heading marks are dropped; `#tag` stays (a
 * heading mark needs a space after the #). Blank lines are skipped.
 */
export function parseIndented(text: string): Tree[] {
  const roots: Tree[] = [];
  const stack: { indent: number; node: Tree }[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)![0];
    let indent = 0;
    for (const c of lead) indent += c === '\t' ? 4 : 1;
    const node: Tree = { text: line.slice(lead.length).replace(HEADING, '').replace(MARKER, '').trimEnd(), children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ indent, node });
  }
  return roots;
}

/** Visits the subtree under `root` (not `root` itself) in pre-order. */
function walk(doc: Doc, root: NodeId, fn: (id: NodeId, depth: number) => void): void {
  const stack: [NodeId, number][] = [];
  const push = (ids: NodeId[], depth: number) => {
    for (let k = ids.length - 1; k >= 0; k--) stack.push([ids[k], depth]);
  };
  push(doc.get(root).children, 0);
  while (stack.length) {
    const [id, depth] = stack.pop()!;
    fn(id, depth);
    push(doc.get(id).children, depth + 1);
  }
}

/** A Markdown list, two spaces per level; reads back with `parseIndented`. */
export function toMarkdown(doc: Doc, root: NodeId = doc.root): string {
  const out: string[] = [];
  walk(doc, root, (id, depth) => out.push(`${'  '.repeat(depth)}- ${doc.get(id).text}`));
  return out.length ? `${out.join('\n')}\n` : '';
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** OPML 2.0, the outline exchange format Workflowy and other outliners read. */
export function toOpml(doc: Doc, title = 'Listik'): string {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    `  <head><title>${escapeXml(title)}</title></head>`,
    '  <body>',
  ];
  const emit = (id: NodeId, depth: number) => {
    const n = doc.get(id);
    const pad = '  '.repeat(depth + 2);
    const open = `${pad}<outline text="${escapeXml(n.text)}"`;
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
      .map((c) => ({ text: (c.getAttribute('text') ?? '').replace(/\s*\n\s*/g, ' '), children: read(c) }));
  return read(body);
}
