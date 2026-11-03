import { TODO_NOTE, firstWord, fillDay } from './calendar';
import type { Ctx } from './commands';
import { clock } from './clock';
import { dateText } from './dates';
import { newId, type Doc } from './doc';
import { compareOrder, titleOf } from './links';
import { content, isSecret, parseTags, searchable } from './tags';
import type { NodeId, Op } from './types';

/**
 * Open tasks under `#project` in PARA are mirrored into Kanban:
 * today's complete date goes to Today, other tasks to Backlog.
 * Each checkbox has its own mirror, sharing its text and completion state.
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

/** Only the complete date written by @today and its aliases, including weekday. */
export function dueToday(doc: Doc, id: NodeId, now = new Date()): boolean {
  const n = doc.content(id);
  if (!n.todo || n.done) return false;
  const tags = new Set(parseTags(content(n)));
  return parseTags(dateText('today', now)!).every((tag) => tags.has(tag));
}

/** A bullet tagged `#project`, in its text or note. */
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

/** The nearest project of a task (or its mirror), including the task itself, inside PARA. */
export function projectOf(doc: Doc, id: NodeId): NodeId | null {
  const para = findPara(doc);
  if (para === null || !doc.has(id)) return null;
  const origin = doc.origin(id);
  if (!doc.inOutline(origin) || !doc.within(origin, para) || !searchable(doc, origin)) return null;
  for (let cur: NodeId | null = origin; cur !== null && cur !== para && cur !== doc.root; cur = doc.get(cur).parent) {
    if (isProject(doc, cur)) return cur;
  }
  return null;
}

/** Open tasks inserted, moved or made checkboxes under a project in PARA, each once. */
export function backlogTargets(doc: Doc, ops: readonly Op[]): NodeId[] {
  const para = findPara(doc);
  if (para === null) return [];
  const tasks = new Set<NodeId>();
  for (const op of ops) {
    if (op.t === 'setTodo') {
      if (op.to) tasks.add(op.id);
    } else if (op.t === 'setText' || op.t === 'setNote' || (op.t === 'setDone' && !op.to)) {
      if ((op.t === 'setText' || op.t === 'setNote') && parseTags(op.from).join(' ') === parseTags(op.to).join(' ')) continue;
      if (doc.has(op.id) && dueToday(doc, op.id)) tasks.add(doc.origin(op.id));
    } else if (op.t === 'insert' || op.t === 'move') {
      const id = op.t === 'insert' ? op.node.id : op.id;
      if (doc.has(id) && doc.inOutline(id)) doc.walk(id, (n) => n.todo && !n.done && !n.mirrorOf && tasks.add(n.id));
    }
  }
  const out: NodeId[] = [];
  for (const task of tasks) {
    if (!doc.has(task) || !doc.inOutline(task) || !doc.get(task).todo || doc.get(task).done || !searchable(doc, task)) continue;
    if (!doc.get(task).mirrorOf && projectOf(doc, task) !== null) out.push(task);
  }
  return out;
}

/** All open project tasks for the start-up check; skips mirrors and secret subtrees. */
export function openProjectTasks(doc: Doc): NodeId[] {
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
    if (n.todo && !n.done && here !== null) out.add(id);
    for (const c of n.children) walk(c, here);
  };
  for (const c of doc.get(para).children) walk(c, null);
  return [...out];
}

/** Replace legacy project cards with their open tasks in the same column. */
export function migrateProjectCards(doc: Doc): void {
  const board = findKanban(doc);
  if (board === null) return;
  const cards: NodeId[] = [];
  doc.walk(board, (n) => {
    if (n.mirrorOf && !doc.content(n.id).todo && projectOf(doc, n.id) === doc.origin(n.id)) cards.push(n.id);
  });
  for (const id of cards) {
    const card = doc.get(id);
    const tasks: NodeId[] = [];
    doc.walk(doc.origin(id), (n) => {
      if (!n.mirrorOf && n.todo && !n.done && projectOf(doc, n.id) !== null) tasks.push(n.id);
    });
    tasks.sort((a, b) => compareOrder(doc, a, b));
    let at = doc.get(card.parent!).children.indexOf(id);
    for (const task of tasks) {
      if (doc.copies(task).some((c) => c !== task && doc.within(c, board))) continue;
      addChild(doc, card.parent!, '', task, '', at++, false, `${card.parent}~${task}`);
    }
    doc.apply({ t: 'remove', parent: card.parent!, node: doc.snapshot(id) });
  }
}

/**
 * Mirrors tasks last and collapsed into Today for today's date, otherwise
 * Backlog, making the board and destination if missing.
 * A bullet with a mirror anywhere in the Kanban (a column, deeper) is left:
 * it is on the board already, wherever it was moved to, and is reported as
 * `known`, so the caller can say so. `added` are the ones that came.
 */
export function toBacklog(doc: Doc, targets: readonly NodeId[], now = new Date()): { added: NodeId[]; known: NodeId[] } {
  const kanban = findKanban(doc);
  const added: NodeId[] = [];
  const known: NodeId[] = [];
  for (const origin of new Set(targets.map((t) => doc.origin(t)))) {
    (kanban !== null && doc.copies(origin).some((c) => c !== origin && doc.within(c, kanban)) ? known : added).push(origin);
  }
  if (!added.length) return { added, known };
  for (const origin of added) {
    let destination: NodeId;
    if (dueToday(doc, origin, now)) destination = ensureToday(doc);
    else {
      let backlog = findBacklog(doc);
      if (backlog === null) {
        const board = findKanban(doc) ?? addChild(doc, doc.root, 'Kanban', undefined, '', undefined, false, KANBAN_ID);
        backlog = addChild(doc, board, 'Backlog', undefined, '', undefined, false, `${board}~backlog`);
      }
      destination = backlog;
    }
    addChild(doc, destination, '', origin, '', undefined, false, `${destination}~${origin}`);
  }
  return { added, known };
}

/** Move existing open, dated mirrors from every other column; never traverse Today. */
export function moveTodayMirrors(doc: Doc, now = new Date(), origins?: readonly NodeId[], beforeMove?: (id: NodeId) => void): NodeId[] {
  const board = findKanban(doc);
  if (board === null) return [];
  let today = findToday(doc);
  const targets: NodeId[] = [];
  const consider = (id: NodeId) => {
    if (doc.get(id).mirrorOf && dueToday(doc, id, now)) targets.push(id);
  };
  if (origins) {
    for (const origin of new Set(origins)) {
      if (!doc.has(origin)) continue;
      for (const id of doc.copies(doc.origin(origin))) {
        if (doc.within(id, board) && (today === null || !doc.within(id, today))) consider(id);
      }
    }
  } else {
    for (const id of doc.get(board).children) {
      if (id !== today) doc.walk(id, (n) => consider(n.id));
    }
  }
  for (const id of targets) {
    beforeMove?.(id);
    today ??= ensureToday(doc);
    const n = doc.get(id);
    doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent: today, order: doc.orderAt(today, doc.get(today).children.length) } });
  }
  return targets;
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

function ensureToday(doc: Doc): NodeId {
  const today = findToday(doc);
  if (today !== null) return today;
  const kanban = findKanban(doc) ?? addChild(doc, doc.root, 'Kanban', undefined, '', undefined, false, KANBAN_ID);
  return addChild(doc, kanban, 'Today', undefined, TODO_NOTE, undefined, false, `${kanban}~today`);
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
  const today = ensureToday(doc);
  addChild(doc, day, '', today, '', Math.min(1, doc.get(day).children.length), true, `${day}~today`);
  return true;
}

/** The mirror of the Today among a day's own bullets, if it has one. */
export function todayMirrorOf(doc: Doc, day: NodeId): NodeId | null {
  const today = findToday(doc);
  return today === null ? null : doc.get(day).children.find((c) => doc.get(c).mirrorOf && doc.origin(c) === today) ?? null;
}
