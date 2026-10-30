import { TODO_NOTE, firstWord, fillDay } from './calendar';
import type { Ctx } from './commands';
import { clock } from './clock';
import { newId, type Doc } from './doc';
import { titleOf } from './links';
import { content, isSecret, parseTags, searchable } from './tags';
import type { NodeId, Op } from './types';

/**
 * Tasks of PARA come to the Kanban's Backlog (October 2026). The `#project`
 * bullet a task lies in (inside PARA) is mirrored into the Backlog, inside the Kanban at the top level; the one lacking is made.
 * Both are found by place and name as the Inbox is: a top-level bullet with
 * the word "kanban" in its title, and in it one with "backlog"; emoji and
 * tags around do not matter. Only changes made here are looked at (an
 * inserted or moved task, a bullet made a task), so a mirror taken out of
 * the Backlog by hand stays out until its bullet changes again.
 */

const KANBAN = 'kanban';
const BACKLOG = 'backlog';
const TODAY = 'today';
const PROJECT = 'project';

/** A bullet tagged `#project`: the unit that comes to the Backlog. */
const isProject = (doc: Doc, id: NodeId): boolean => {
  const text = content(doc.get(id));
  return text.includes('#') && parseTags(text).includes(PROJECT);
};

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

/**
 * The bullets to mirror after `ops`: for each task they added or made that
 * lies inside PARA, the nearest bullet at or above it tagged `#project`
 * (Projects → Work → Group → PBR #project → timeline → day → task gives PBR);
 * a task under no project is left. Done tasks do not count: a project with
 * only those has nothing to do on the board. Each only once.
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
      if (doc.has(id) && doc.inOutline(id)) doc.walk(id, (n) => n.todo && !n.done && !n.mirrorOf && tasks.add(n.id));
    }
  }
  const out: NodeId[] = [];
  for (const task of tasks) {
    if (!doc.has(task) || !doc.inOutline(task) || !doc.get(task).todo || doc.get(task).done || !searchable(doc, task)) continue;
    // Up from the task to the nearest `#project`, which must lie inside PARA.
    let cur: NodeId | null = task;
    while (cur !== null && cur !== para && cur !== doc.root && !isProject(doc, cur)) cur = doc.get(cur).parent;
    if (cur === null || cur === para || cur === doc.root || !doc.within(cur, para) || out.includes(cur)) continue;
    out.push(cur);
  }
  return out;
}

/**
 * The projects in PARA that have an open task (a checkbox not yet ticked)
 * anywhere inside, one walk down the tree: the nearest `#project` above each
 * task, as in `backlogTargets`. For the check at start-up, which makes sure
 * the Backlog holds them (`toBacklog`). Mirrors and `#secret` are not walked.
 */
export function openProjects(doc: Doc): NodeId[] {
  const para = findPara(doc);
  if (para === null || isSecret(doc.get(para))) return [];
  const out = new Set<NodeId>();
  const walk = (id: NodeId, project: NodeId | null): void => {
    const n = doc.get(id);
    if (n.mirrorOf) return;
    const text = content(n);
    const tagged = text.includes('#');
    if (tagged && isSecret(n)) return;
    const here = tagged && parseTags(text).includes(PROJECT) ? id : project;
    if (n.todo && !n.done && here !== null) out.add(here);
    for (const c of n.children) walk(c, here);
  };
  for (const c of doc.get(para).children) walk(c, null);
  return [...out];
}

/**
 * Mirrors the bullets into the Backlog, last, collapsed (a project shows its
 * next task under it), making the Kanban and the Backlog if they are missing.
 * A bullet with a mirror anywhere in the Kanban (a column, deeper) is left:
 * it is on the board already, wherever it was moved to, and is reported as
 * `known`, so the caller can say so. `added` are the ones that came.
 */
export function toBacklog(doc: Doc, targets: readonly NodeId[]): { added: NodeId[]; known: NodeId[] } {
  const kanban = findKanban(doc);
  const added: NodeId[] = [];
  const known: NodeId[] = [];
  for (const origin of new Set(targets.map((t) => doc.origin(t)))) {
    (kanban !== null && doc.copies(origin).some((c) => c !== origin && doc.within(c, kanban)) ? known : added).push(origin);
  }
  if (!added.length) return { added, known };
  let backlog = findBacklog(doc);
  if (backlog === null) {
    const board = kanban ?? addChild(doc, doc.root, 'Kanban', undefined, '', undefined, false, KANBAN_ID);
    backlog = addChild(doc, board, 'Backlog', undefined, '', undefined, false, `${board}~backlog`);
  }
  for (const origin of added) addChild(doc, backlog, '', origin, '', undefined, false, `${backlog}~${origin}`);
  return { added, known };
}

/**
 * Ids of what the Backlog and a day make by themselves, alike on every
 * device (calendar.ts `fixedIds`): two devices adding the same mirror, or
 * the Kanban, before they heard of each other end with one. Taken only
 * while free; one in the trash, say, leaves a random id.
 */
const KANBAN_ID = 'kanban~';

function addChild(doc: Doc, parent: NodeId, text: string, mirrorOf?: NodeId, note = '', at?: number, open = false, fixed?: NodeId): NodeId {
  const id = fixed !== undefined && !doc.has(fixed) ? fixed : newId();
  const now = clock.now();
  doc.apply({
    t: 'insert',
    parent,
    node: {
      id, order: doc.orderAt(parent, at ?? doc.get(parent).children.length), text, note, collapsed: !!mirrorOf && !open, todo: false, done: false,
      created: now, updated: now, children: [], ...(mirrorOf ? { mirrorOf } : {}),
    },
  });
  return id;
}

/** The Today inside the Kanban, if there is one. */
export function findToday(doc: Doc): NodeId | null {
  const kanban = findKanban(doc);
  return kanban === null ? null : findChild(doc, kanban, TODAY);
}

/**
 * A new day's template (model/calendar.ts `fillDay`) with a mirror of the
 * Kanban's Today where a list of its own used to be, after the notes, open.
 * The Today (and the Kanban) is made if missing, its caption the contexts
 * `TODO_NOTE`. False if the day had its content already.
 */
export function fillDayToday(ctx: Ctx, day: NodeId): boolean {
  const { doc } = ctx;
  if (!fillDay(ctx, day)) return false;
  let today = findToday(doc);
  if (today === null) {
    const kanban = findKanban(doc) ?? addChild(doc, doc.root, 'Kanban', undefined, '', undefined, false, KANBAN_ID);
    today = addChild(doc, kanban, 'Today', undefined, TODO_NOTE, undefined, false, `${kanban}~today`);
  }
  addChild(doc, day, '', today, '', Math.min(1, doc.get(day).children.length), true, `${day}~today`);
  return true;
}

/** The mirror of the Today among a day's own bullets, if it has one. */
export function todayMirrorOf(doc: Doc, day: NodeId): NodeId | null {
  const today = findToday(doc);
  return today === null ? null : doc.get(day).children.find((c) => doc.get(c).mirrorOf && doc.origin(c) === today) ?? null;
}
