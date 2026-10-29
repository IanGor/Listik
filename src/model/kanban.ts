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

/** Columns where a bullet stays put: the Kanban's Week and Today, at any depth in it. */
const HELD: string[] = ['week', 'today', 'неделя', 'сегодня'];

/**
 * The bullets to bring to the Backlog after `ops`: the first level under
 * PARA's folder (Projects, Areas, …) that something was added to, however
 * deep: a bullet added in Projects → Alpha → Sub gives Alpha. A task made or
 * added right in a folder is its own (a bullet added there is a new first
 * level, not an addition to one). A bullet moved inside the same first level
 * is not an addition. Each only once.
 */
export function backlogTargets(doc: Doc, ops: readonly Op[]): NodeId[] {
  const para = findPara(doc);
  if (para === null) return [];
  const out: NodeId[] = [];
  /** `id` was added or made; `own`: it counts as its own first level (a task). */
  const add = (id: NodeId, own: boolean, from?: NodeId | null) => {
    if (!doc.has(id) || !doc.inOutline(id) || !searchable(doc, id)) return;
    // The path from the bullet up to PARA's own child.
    const path: NodeId[] = [];
    let cur: NodeId | null = id;
    while (cur !== null && cur !== para && cur !== doc.root) {
      path.push(cur);
      cur = doc.get(cur).parent;
    }
    if (cur !== para) return;
    path.pop(); // the Projects, Areas, … themselves are never mirrored
    const target = path[path.length - 1];
    if (target === undefined || (target === id && !own) || out.includes(target)) return;
    if (from && doc.within(from, target)) return;
    out.push(target);
  };
  for (const op of ops) {
    if (op.t === 'setTodo') {
      if (op.to) add(op.id, true);
    } else if (op.t === 'insert' || op.t === 'move') {
      const id = op.t === 'insert' ? op.node.id : op.id;
      if (!doc.has(id)) continue;
      let task = false;
      doc.walk(id, (n) => void (task ||= n.todo && !n.mirrorOf));
      add(id, task, op.t === 'move' ? op.from.parent : null);
    }
  }
  return out;
}

/** Is the mirror in a column that holds it (Week, Today) inside the Kanban? */
function held(doc: Doc, kanban: NodeId, mirror: NodeId): boolean {
  for (let p = doc.get(mirror).parent; p !== null && p !== kanban; p = doc.get(p).parent) {
    const words: string[] = titleOf(doc.content(p).text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (HELD.some((h) => words.includes(h))) return true;
  }
  return false;
}

/**
 * Brings the bullets to the Backlog, last: a mirror of each, collapsed (a
 * project shows its next task under it), making the Kanban and the Backlog
 * if they are missing. A bullet whose mirror is in Week or Today stays
 * there; one whose mirror is elsewhere in the Kanban (another column,
 * deeper) is moved to the Backlog; one already in the Backlog stays.
 * Returns how many were mirrored or moved.
 */
export function toBacklog(doc: Doc, targets: readonly NodeId[]): number {
  const kanban = findKanban(doc);
  let backlog = findBacklog(doc);
  let done = 0;
  for (const t of targets) {
    const origin = doc.origin(t);
    const mirrors: NodeId[] = kanban === null ? [] : doc.copies(origin).filter((c) => c !== origin && doc.within(c, kanban));
    if (mirrors.some((m) => held(doc, kanban!, m) || doc.get(m).parent === backlog)) continue;
    if (backlog === null) backlog = addChild(doc, kanban ?? addChild(doc, doc.root, 'Kanban'), 'Backlog');
    if (mirrors.length) {
      const m = doc.get(mirrors[0]);
      doc.apply({ t: 'move', id: m.id, from: { parent: m.parent!, order: m.order }, to: { parent: backlog, order: doc.orderAt(backlog, doc.get(backlog).children.length) } });
    } else {
      addChild(doc, backlog, '', origin);
    }
    done++;
  }
  return done;
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
