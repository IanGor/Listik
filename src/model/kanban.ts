import { firstWord } from './calendar';
import { clock } from './clock';
import { newId, type Doc } from './doc';
import { titleOf } from './links';
import { searchable } from './tags';
import type { NodeId, Op } from './types';

/**
 * Tasks of PARA come to the Kanban's Backlog (October 2026). A bullet inside
 * PARA that is a task, or holds one right in it, is mirrored into the
 * Backlog, inside the Kanban at the top level; the one lacking is made.
 * Both are found by place and name as the Inbox is: a top-level bullet with
 * the word "kanban" in its title, and in it one with "backlog"; emoji and
 * tags around do not matter. Only changes made here are looked at (an
 * inserted or moved task, a bullet made a task), so a mirror taken out of
 * the Backlog by hand stays out until its bullet changes again.
 */

const KANBAN = 'kanban';
const BACKLOG = 'backlog';

const hasWord = (text: string, word: string) =>
  titleOf(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.includes(word) ?? false;

/** The first child of `parent` with the word in its title; for a mirror, the bullet that holds its children. */
function findChild(doc: Doc, parent: NodeId, word: string): NodeId | null {
  const id = doc.get(parent).children.find((c) => hasWord(doc.content(c).text, word));
  return id === undefined ? null : doc.host(id)?.id ?? null;
}

/** The Kanban at the top level, if there is one. */
export const findKanban = (doc: Doc): NodeId | null => findChild(doc, doc.root, KANBAN);

/** The Backlog inside the Kanban, if there is one. */
export function findBacklog(doc: Doc): NodeId | null {
  const kanban = findKanban(doc);
  return kanban === null ? null : findChild(doc, kanban, BACKLOG);
}

/** The structure's PARA: the top-level bullet whose first word is "PARA". */
function findPara(doc: Doc): NodeId | null {
  const id = doc.get(doc.root).children.find((c) => firstWord(doc.content(c).text) === 'para');
  return id === undefined ? null : doc.host(id)?.id ?? null;
}

/** Holds a task: is one, or has one right in it. */
function holdsTask(doc: Doc, id: NodeId): boolean {
  const n = doc.get(id);
  return !n.mirrorOf && (n.todo || n.children.some((c) => !doc.get(c).mirrorOf && doc.get(c).todo));
}

/**
 * The bullets to mirror after `ops`: for each task they added or made, the
 * topmost bullet holding a task that lies inside PARA below its four (a
 * task right in Projects is its own). Each only once.
 */
export function backlogTargets(doc: Doc, ops: readonly Op[]): NodeId[] {
  const para = findPara(doc);
  if (para === null) return [];
  const tasks = new Set<NodeId>();
  for (const op of ops) {
    if (op.t === 'setTodo') {
      if (op.to) tasks.add(op.id);
    } else if (op.t === 'insert' || op.t === 'move') {
      const id = op.t === 'insert' ? op.node.id : op.id;
      if (doc.has(id) && doc.inOutline(id)) doc.walk(id, (n) => n.todo && !n.mirrorOf && tasks.add(n.id));
    }
  }
  const out: NodeId[] = [];
  for (const task of tasks) {
    if (!doc.has(task) || !doc.inOutline(task) || !searchable(doc, task)) continue;
    // The path from the task up to PARA's own child.
    const path: NodeId[] = [];
    let cur: NodeId | null = task;
    while (cur !== null && cur !== para && cur !== doc.root) {
      path.push(cur);
      cur = doc.get(cur).parent;
    }
    if (cur !== para) continue;
    path.pop(); // the Projects, Areas, … themselves are never mirrored
    let target: NodeId | null = null;
    for (const id of path) if (holdsTask(doc, id)) target = id;
    if (target !== null && !out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * Mirrors the bullets into the Backlog, last, collapsed (a project shows its
 * next task under it), making the Kanban and the Backlog if they are missing;
 * one already there stays as it is. Returns how many came.
 */
export function toBacklog(doc: Doc, targets: readonly NodeId[]): number {
  if (!targets.length) return 0;
  let backlog = findBacklog(doc);
  if (backlog !== null && targets.every((t) => doc.copies(doc.origin(t)).some((c) => doc.get(c).parent === backlog))) return 0;
  if (backlog === null) {
    let kanban = findKanban(doc);
    if (kanban === null) kanban = addChild(doc, doc.root, 'Kanban');
    backlog = addChild(doc, kanban, 'Backlog');
  }
  let added = 0;
  const list = backlog;
  for (const t of targets) {
    const origin = doc.origin(t);
    if (doc.copies(origin).some((c) => doc.get(c).parent === list)) continue;
    addChild(doc, list, '', origin);
    added++;
  }
  return added;
}

function addChild(doc: Doc, parent: NodeId, text: string, mirrorOf?: NodeId): NodeId {
  const id = newId();
  const now = clock.now();
  doc.apply({
    t: 'insert',
    parent,
    node: {
      id, order: doc.orderAt(parent, doc.get(parent).children.length), text, note: '', collapsed: !!mirrorOf, todo: false, done: false,
      created: now, updated: now, children: [], ...(mirrorOf ? { mirrorOf } : {}),
    },
  });
  return id;
}
