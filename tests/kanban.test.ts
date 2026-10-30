import { describe, expect, it } from 'vitest';
import { backlogTargets, findBacklog, findKanban, openProjects, toBacklog } from '../src/model/kanban';
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


describe('the Backlog of the Kanban', () => {
  const para = ['PARA', '  Projects', '    Alpha #project', '      one', '      two', '  Areas', '    solo #project'];

  it('a task makes its project a mirror in a new Kanban and Backlog', () => {
    const doc = build([...para, '📥 Inbox']);
    task(doc, 'one');
    const kanban = findKanban(doc)!;
    const backlog = findBacklog(doc)!;
    expect(doc.get(kanban).text).toBe('Kanban');
    expect(doc.get(backlog).text).toBe('Backlog');
    expect(doc.get(backlog).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha #project']);
    checkInvariants(doc);
  });

  it('a second task in the same project adds nothing; a task right in Areas is its own', () => {
    const doc = build(para);
    task(doc, 'one');
    task(doc, 'two');
    task(doc, 'solo #project');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha #project', 'solo #project']);
  });

  it('the first level under a PARA folder is mirrored, however deep the task lies', () => {
    const doc = build(['PARA', '  Projects', '    Alpha #project', '      Phase', '        Step', '          deep']);
    task(doc, 'deep');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha #project']);
  });

  it('a mirror anywhere in the Kanban keeps it from coming again', () => {
    const doc = build([...para, 'Kanban', '  Backlog', '  Doing', '    Wip']);
    doc.apply({
      t: 'insert', parent: 'Wip',
      node: { id: 'm', order: doc.orderAt('Wip', 0), text: '', note: '', collapsed: true, todo: false, done: false, created: 0, updated: 0, children: [], mirrorOf: 'Alpha #project' },
    });
    task(doc, 'one');
    task(doc, 'two');
    expect(doc.get('Backlog').children).toHaveLength(0);
    task(doc, 'solo #project');
    expect(doc.get('Backlog').children.map((c) => doc.get(c).mirrorOf)).toEqual(['solo #project']);
  });

  it('a project already on the board is reported as known, not mirrored again', () => {
    const doc = build(para);
    expect(task(doc, 'one')).toEqual({ added: ['Alpha #project'], known: [] });
    expect(task(doc, 'two')).toEqual({ added: [], known: ['Alpha #project'] });
    expect(doc.get(findBacklog(doc)!).children).toHaveLength(1);
  });

  it('after a reload (a snapshot), the mirror already in the Backlog keeps it from coming again', () => {
    const doc = build(para);
    task(doc, 'one');
    const back = deserialize(serialize(doc));
    task(back, 'two');
    expect(back.get(findBacklog(back)!).children.map((c) => back.get(c).mirrorOf)).toEqual(['Alpha #project']);
  });

  it('two devices making the same project a task at once end with one Kanban and one mirror of it', () => {
    const base = build(para);
    const a = deserialize(serialize(base));
    const b = deserialize(serialize(base));
    const fromA = a.transact(() => { a.apply({ t: 'setTodo', id: 'one', from: false, to: true }); toBacklog(a, ['Alpha #project']); });
    const fromB = b.transact(() => { b.apply({ t: 'setTodo', id: 'two', from: false, to: true }); toBacklog(b, ['Alpha #project']); });
    const c = deserialize(serialize(base));
    for (const op of [...fromA, ...fromB]) applyMerged(c, op);
    expect(c.get(c.root).children.filter((k) => c.get(k).text === 'Kanban')).toHaveLength(1);
    expect(c.get(findBacklog(c)!).children.map((k) => c.get(k).mirrorOf)).toEqual(['Alpha #project']);
    checkInvariants(c);
  });

  it('finds them by place and word, with emoji and tags around', () => {
    const doc = build([...para, '🗂 KANBAN #board', '  ⏳ backlog @x', '  Doing']);
    task(doc, 'one');
    expect(findKanban(doc)).toBe('🗂 KANBAN #board');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha #project']);
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
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Beta #project']);
  });

  it('the #project is mirrored, not the groups above it nor the bullets below it', () => {
    const doc = build(['PARA', '  Projects', '    Work', '      Stream', '        PBR #project @work', '          timeline', '            day', '              t']);
    task(doc, 't');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['PBR #project @work']);
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

  it('finds the projects with an open task, the nearest #project of each, once', () => {
    const doc = build(['PARA', '  Projects', '    Alpha #project', '      a1', '      a2', '      Inner #project', '        a3', '    Plain', '      p1', '    Beta #project', '      b1', 'Elsewhere #project', '  e1']);
    for (const id of ['a1', 'a2', 'a3', 'p1', 'b1', 'e1']) open(doc, id);
    done(doc, 'b1');
    expect(openProjects(doc).sort()).toEqual(['Alpha #project', 'Inner #project']);
  });

  it('skips #secret, mirrors and a project with no tasks; no PARA, nothing', () => {
    const doc = build(['PARA', '  Projects', '    Hidden #secret #project', '      t', '    Empty #project', '      x']);
    open(doc, 't');
    expect(openProjects(doc)).toEqual([]);
    expect(openProjects(build(['Elsewhere #project', '  t']))).toEqual([]);
  });

  it('brings the missing ones to the Backlog and leaves those on the board', () => {
    const doc = build([...para, 'Kanban', '  Backlog']);
    open(doc, 'one');
    open(doc, 'solo #project');
    const first = toBacklog(doc, openProjects(doc));
    expect(first.added.sort()).toEqual(['Alpha #project', 'solo #project']);
    expect(toBacklog(doc, openProjects(doc))).toEqual({ added: [], known: ['Alpha #project', 'solo #project'].sort() });
    expect(doc.get('Backlog').children).toHaveLength(2);
  });

  it('with nothing to bring, no Kanban is made', () => {
    const doc = build(para);
    expect(toBacklog(doc, openProjects(doc))).toEqual({ added: [], known: [] });
    expect(findKanban(doc)).toBeNull();
  });
});
