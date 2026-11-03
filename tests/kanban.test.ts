import { describe, expect, it } from 'vitest';
import { backlogTargets, dueToday, findBacklog, findKanban, findToday, migrateProjectCards, moveTodayMirrors, openProjectTasks, projectOf, toBacklog } from '../src/model/kanban';
import { dateText } from '../src/model/dates';
import type { Doc } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { applyMerged } from '../src/model/merge';
import { deserialize, serialize } from '../src/persist/serialize';
import { build } from './helpers';

/** Makes the bullet a task, as the command does, and lets the Backlog follow. */
function task(doc: Doc, id: string) {
  const ops = doc.transact(() => doc.apply({ t: 'setTodo', id, from: false, to: true }));
  return toBacklog(doc, backlogTargets(doc, ops));
}

describe('dated Kanban tasks', () => {
  const now = new Date(2026, 10, 3, 12);
  const today = dateText('today', now)!;
  const tomorrow = dateText('tomorrow', now)!;
  const fixture = () => build(['PARA', '  Alpha #project', '    task', '    later', '    finished', 'Elsewhere', '  outside', 'Kanban', '  Backlog', '  Doing', '  Done', '  Today']);
  const date = (doc: Doc, id: string, value: string, note = false) => {
    doc.apply({ t: 'setTodo', id, from: false, to: true });
    doc.apply(note ? { t: 'setNote', id, from: '', to: value } : { t: 'setText', id, from: doc.get(id).text, to: `${id} ${value}` });
  };
  const mirror = (doc: Doc, id: string, parent: string, origin: string) => doc.apply({
    t: 'insert', parent, node: { id, order: doc.orderAt(parent, doc.get(parent).children.length), text: '', note: '', todo: false, done: false, collapsed: true, created: 0, updated: 0, children: [], mirrorOf: origin },
  });

  it('sends today directly to Today, tomorrow to Backlog; text and notes use the full date', () => {
    const doc = fixture();
    date(doc, 'task', today, true);
    date(doc, 'later', tomorrow);
    expect(toBacklog(doc, ['task', 'later'], now).added).toEqual(['task', 'later']);
    expect(doc.get('Today').children.map((id) => doc.origin(id))).toEqual(['task']);
    expect(doc.get('Backlog').children.map((id) => doc.origin(id))).toEqual(['later']);
    expect(dueToday(doc, 'later', now)).toBe(false);
    checkInvariants(doc);
  });

  it('requires all the tags produced by the date-word replacement', () => {
    for (const missing of today.split(' ')) {
      const doc = fixture();
      date(doc, 'task', today.split(' ').filter((t) => t !== missing).join(' '));
      expect(dueToday(doc, 'task', now)).toBe(false);
    }
  });

  it('creates a missing Today once, without making an unused Backlog or duplicate mirrors', () => {
    const doc = build(['PARA', '  Alpha #project', '    task']);
    date(doc, 'task', today);
    toBacklog(doc, ['task'], now);
    const destination = findToday(doc)!;
    expect(doc.get(destination).children).toHaveLength(1);
    expect(findBacklog(doc)).toBeNull();
    expect(toBacklog(doc, ['task'], now)).toEqual({ added: [], known: ['task'] });
  });

  it('moves the same mirror from any other column, including nested cards and non-PARA tasks; skips completed tasks and Today', () => {
    const doc = fixture();
    for (const id of ['task', 'outside', 'finished']) date(doc, id, today);
    date(doc, 'later', tomorrow);
    doc.apply({ t: 'setDone', id: 'finished', from: false, to: true, at: 1 });
    mirror(doc, 'a', 'Backlog', 'task');
    mirror(doc, 'b', 'Done', 'outside');
    mirror(doc, 'c', 'Doing', 'finished');
    mirror(doc, 'd', 'Doing', 'later');
    mirror(doc, 'already', 'Today', 'task');
    expect(moveTodayMirrors(doc, now).sort()).toEqual(['a', 'b']);
    expect(doc.get('a').parent).toBe('Today');
    expect(doc.get('b').parent).toBe('Today');
    expect(doc.get('c').parent).toBe('Doing');
    expect(doc.get('d').parent).toBe('Doing');
    expect(moveTodayMirrors(doc, now)).toEqual([]);
    expect(doc.get('Today').children).toEqual(['already', 'a', 'b']);
    checkInvariants(doc);
  });

  it('checks only changed originals on edits, and catches tomorrow on the next day', () => {
    const doc = fixture();
    date(doc, 'task', today);
    date(doc, 'later', tomorrow);
    mirror(doc, 'a', 'Doing', 'task');
    mirror(doc, 'b', 'Backlog', 'later');
    expect(moveTodayMirrors(doc, now, ['later'])).toEqual([]);
    expect(moveTodayMirrors(doc, now, ['task'])).toEqual(['a']);
    expect(moveTodayMirrors(doc, new Date(2026, 10, 4, 0, 1))).toEqual(['b']);
    checkInvariants(doc);
  });

  it('recognizes changed dates and reopened tasks without recreating cards for ordinary typing', () => {
    const doc = fixture();
    date(doc, 'task', dateText('today')!);
    const from = doc.get('task').text;
    const to = `${from} more words`;
    doc.apply({ t: 'setText', id: 'task', from, to });
    expect(backlogTargets(doc, [{ t: 'setText', id: 'task', from, to }])).toEqual([]);
    expect(backlogTargets(doc, [{ t: 'setText', id: 'task', from: 'task', to }])).toEqual(['task']);
    expect(backlogTargets(doc, [{ t: 'setDone', id: 'task', from: true, to: false, at: 1 }])).toEqual(['task']);
  });
});


describe('the Backlog of the Kanban', () => {
  const para = ['PARA', '  Projects', '    Alpha #project', '      one', '      two', '  Areas', '    solo #project'];

  it('a task becomes a mirror in a new Kanban and Backlog', () => {
    const doc = build([...para, '📥 Inbox']);
    task(doc, 'one');
    const kanban = findKanban(doc)!;
    const backlog = findBacklog(doc)!;
    expect(doc.get(kanban).text).toBe('Kanban');
    expect(doc.get(backlog).text).toBe('Backlog');
    expect(doc.get(backlog).children.map((c) => doc.get(c).mirrorOf)).toEqual(['one']);
    checkInvariants(doc);
  });

  it('each task in the same project gets its own mirror, including a project checkbox', () => {
    const doc = build(para);
    task(doc, 'one');
    task(doc, 'two');
    task(doc, 'solo #project');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['one', 'two', 'solo #project']);
  });

  it('a task is mirrored however deep under a project it lies', () => {
    const doc = build(['PARA', '  Projects', '    Alpha #project', '      Phase', '        Step', '          deep']);
    task(doc, 'deep');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['deep']);
  });

  it('a mirror anywhere in the Kanban keeps it from coming again', () => {
    const doc = build([...para, 'Kanban', '  Backlog', '  Doing', '    Wip']);
    doc.apply({
      t: 'insert', parent: 'Wip',
      node: { id: 'm', order: doc.orderAt('Wip', 0), text: '', note: '', collapsed: true, todo: false, done: false, created: 0, updated: 0, children: [], mirrorOf: 'one' },
    });
    task(doc, 'one');
    task(doc, 'two');
    expect(doc.get('Backlog').children.map((c) => doc.get(c).mirrorOf)).toEqual(['two']);
    task(doc, 'solo #project');
    expect(doc.get('Backlog').children.map((c) => doc.get(c).mirrorOf)).toEqual(['two', 'solo #project']);
  });

  it('only the same task already on the board is reported as known', () => {
    const doc = build(para);
    expect(task(doc, 'one')).toEqual({ added: ['one'], known: [] });
    expect(task(doc, 'two')).toEqual({ added: ['two'], known: [] });
    expect(toBacklog(doc, ['one'])).toEqual({ added: [], known: ['one'] });
    expect(doc.get(findBacklog(doc)!).children).toHaveLength(2);
  });

  it('after a reload (a snapshot), the mirror already in the Backlog keeps it from coming again', () => {
    const doc = build(para);
    task(doc, 'one');
    const back = deserialize(serialize(doc));
    task(back, 'two');
    expect(back.get(findBacklog(back)!).children.map((c) => back.get(c).mirrorOf)).toEqual(['one', 'two']);
  });

  it('two devices making the same bullet a task at once end with one Kanban and one mirror of it', () => {
    const base = build(para);
    const a = deserialize(serialize(base));
    const b = deserialize(serialize(base));
    const fromA = a.transact(() => { a.apply({ t: 'setTodo', id: 'one', from: false, to: true }); toBacklog(a, ['one']); });
    const fromB = b.transact(() => { b.apply({ t: 'setTodo', id: 'one', from: false, to: true }); toBacklog(b, ['one']); });
    const c = deserialize(serialize(base));
    for (const op of [...fromA, ...fromB]) applyMerged(c, op);
    expect(c.get(c.root).children.filter((k) => c.get(k).text === 'Kanban')).toHaveLength(1);
    expect(c.get(findBacklog(c)!).children.map((k) => c.get(k).mirrorOf)).toEqual(['one']);
    checkInvariants(c);
  });

  it('finds them by place and word, with emoji and tags around', () => {
    const doc = build([...para, '🗂 KANBAN #board', '  ⏳ backlog @x', '  Doing']);
    task(doc, 'one');
    expect(findKanban(doc)).toBe('🗂 KANBAN #board');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['one']);
    expect(doc.get('🗂 KANBAN #board').children).toHaveLength(2);
  });

  it('a Kanban without a Backlog gets one; a Kanban deeper than the top level is not one', () => {
    const doc = build([...para, 'Kanban', '  Doing']);
    task(doc, 'one');
    expect(doc.get('Kanban').children.map((c) => doc.get(c).text)).toEqual(['Doing', 'Backlog']);
    const deep = build([...para, 'Other', '  Kanban']);
    task(deep, 'one');
    expect(deep.get(deep.root).children.map((c) => deep.get(c).text)).toEqual(['PARA', 'Other', 'Kanban']);
    expect(deep.get('Other').children).toHaveLength(1);
  });

  it('only PARA counts: tasks elsewhere are left, and a mirror in PARA is not a project', () => {
    const doc = build([...para, 'Elsewhere', '  loose']);
    task(doc, 'loose');
    expect(findKanban(doc)).toBeNull();
  });

  it('an inserted or moved subtree with a task comes along', () => {
    const doc = build([...para, 'Elsewhere', '  Beta #project', '    chore']);
    doc.apply({ t: 'setTodo', id: 'chore', from: false, to: true });
    expect(findKanban(doc)).toBeNull();
    const ops = doc.transact(() => doc.apply({ t: 'move', id: 'Beta #project', from: { parent: 'Elsewhere', order: doc.get('Beta #project').order }, to: { parent: 'Areas', order: doc.orderAt('Areas', 1) } }));
    toBacklog(doc, backlogTargets(doc, ops));
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['chore']);
  });

  it('the checkbox is mirrored, not the project or groups above it', () => {
    const doc = build(['PARA', '  Projects', '    Work', '      Stream', '        PBR #project @work', '          timeline', '            day', '              t']);
    task(doc, 't');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['t']);
  });

  it('a task under no #project, or under one outside PARA, is left', () => {
    const doc = build(['PARA', '  Projects', '    Plain', '      t', 'Elsewhere #project', '  u']);
    task(doc, 't');
    task(doc, 'u');
    expect(findKanban(doc)).toBeNull();
  });

  it('a #secret project is not mirrored', () => {
    const doc = build(['PARA', '  Projects', '    Hidden #secret #project', '      t']);
    task(doc, 't');
    expect(findKanban(doc)).toBeNull();
  });

  it('only done tasks bring nothing: a task made already done, or a project moved in with only done ones', () => {
    const doc = build(['PARA', '  Projects', '  Beta #project', '    finished', 'Elsewhere', '  Gamma #project', '    ticked']);
    const made = doc.transact(() => {
      doc.apply({ t: 'setTodo', id: 'finished', from: false, to: true });
      doc.apply({ t: 'setDone', id: 'finished', from: false, to: true, at: 1 });
    });
    expect(backlogTargets(doc, made)).toEqual([]);
    doc.apply({ t: 'setTodo', id: 'ticked', from: false, to: true });
    doc.apply({ t: 'setDone', id: 'ticked', from: false, to: true, at: 1 });
    const ops = doc.transact(() => doc.apply({ t: 'move', id: 'Gamma #project', from: { parent: 'Elsewhere', order: doc.get('Gamma #project').order }, to: { parent: 'Projects', order: doc.orderAt('Projects', 0) } }));
    expect(backlogTargets(doc, ops)).toEqual([]);
  });
});

describe('the start-up check of the Backlog', () => {
  const para = ['PARA', '  Projects', '    Alpha #project', '      one', '      two', '  Areas', '    solo #project'];
  const open = (doc: Doc, id: string) => doc.apply({ t: 'setTodo', id, from: false, to: true });
  const done = (doc: Doc, id: string) => doc.apply({ t: 'setDone', id, from: false, to: true, at: 1 });

  it('finds every open checkbox under a project, including nested projects', () => {
    const doc = build(['PARA', '  Projects', '    Alpha #project', '      a1', '      a2', '      Inner #project', '        a3', '    Plain', '      p1', '    Beta #project', '      b1', 'Elsewhere #project', '  e1']);
    for (const id of ['a1', 'a2', 'a3', 'p1', 'b1', 'e1']) open(doc, id);
    done(doc, 'b1');
    expect(openProjectTasks(doc).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('skips #secret, mirrors and a project with no tasks; no PARA, nothing', () => {
    const doc = build(['PARA', '  Projects', '    Hidden #secret #project', '      t', '    Empty #project', '      x']);
    open(doc, 't');
    expect(openProjectTasks(doc)).toEqual([]);
    expect(openProjectTasks(build(['Elsewhere #project', '  t']))).toEqual([]);
  });

  it('brings the missing ones to the Backlog and leaves those on the board', () => {
    const doc = build([...para, 'Kanban', '  Backlog']);
    open(doc, 'one');
    open(doc, 'solo #project');
    const first = toBacklog(doc, openProjectTasks(doc));
    expect(first.added.sort()).toEqual(['one', 'solo #project']);
    expect(toBacklog(doc, openProjectTasks(doc))).toEqual({ added: [], known: ['one', 'solo #project'].sort() });
    expect(doc.get('Backlog').children).toHaveLength(2);
  });

  it('with nothing to bring, no Kanban is made', () => {
    const doc = build(para);
    expect(toBacklog(doc, openProjectTasks(doc))).toEqual({ added: [], known: [] });
    expect(findKanban(doc)).toBeNull();
  });
});


describe('project names and legacy Kanban cards', () => {
  it('resolves the nearest project from a task mirror, including a project checkbox and tags in notes', () => {
    const doc = build(['PARA', '  Projects', '    Outer #project', '      Inner', '        task']);
    doc.apply({ t: 'setNote', id: 'Inner', from: '', to: '#project' });
    task(doc, 'task');
    const mirror = doc.get(findBacklog(doc)!).children[0];
    expect(projectOf(doc, mirror)).toBe('Inner');
    expect(projectOf(doc, 'Outer #project')).toBe('Outer #project');
    doc.apply({ t: 'setText', id: 'Inner', from: 'Inner', to: 'Renamed' });
    expect(doc.get(projectOf(doc, mirror)!).text).toBe('Renamed');
    doc.apply({ t: 'setDone', id: doc.origin(mirror), from: false, to: true, at: 1 });
    expect(doc.content(mirror).done).toBe(true);
  });

  it('replaces old project mirrors in their column, keeps existing task cards and skips done and secret tasks', () => {
    const doc = build(['PARA', '  Projects', '    Alpha #project', '      one', '      two', '      finished', '      Hidden #secret', '        private', 'Kanban', '  Backlog', '  Doing']);
    for (const id of ['one', 'two', 'finished', 'private']) doc.apply({ t: 'setTodo', id, from: false, to: true });
    doc.apply({ t: 'setDone', id: 'finished', from: false, to: true, at: 1 });
    toBacklog(doc, ['one']);
    doc.apply({ t: 'insert', parent: 'Doing', node: { id: 'old', order: doc.orderAt('Doing', 0), text: '', note: '', collapsed: true, todo: false, done: false, created: 0, updated: 0, children: [], mirrorOf: 'Alpha #project' } });
    migrateProjectCards(doc);
    expect(doc.get('Doing').children.map((c) => doc.get(c).mirrorOf)).toEqual(['two']);
    expect(doc.get('Backlog').children.map((c) => doc.get(c).mirrorOf)).toEqual(['one']);
    expect(doc.has('Alpha #project')).toBe(true);
    migrateProjectCards(doc);
    expect(toBacklog(doc, openProjectTasks(doc)).added).toEqual([]);
    checkInvariants(doc);
  });
});
