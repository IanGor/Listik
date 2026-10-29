import { describe, expect, it } from 'vitest';
import { backlogTargets, findBacklog, findKanban, toBacklog } from '../src/model/kanban';
import type { Doc } from '../src/model/doc';
import { checkInvariants } from '../src/model/invariants';
import { build } from './helpers';

/** Makes the bullet a task, as the command does, and lets the Backlog follow. */
function task(doc: Doc, id: string): void {
  const ops = doc.transact(() => doc.apply({ t: 'setTodo', id, from: false, to: true }));
  toBacklog(doc, backlogTargets(doc, ops));
}


describe('the Backlog of the Kanban', () => {
  const para = ['PARA', '  Projects', '    Alpha', '      one', '      two', '  Areas', '    solo'];

  it('a task makes its project a mirror in a new Kanban and Backlog', () => {
    const doc = build([...para, '📥 Inbox']);
    task(doc, 'one');
    const kanban = findKanban(doc)!;
    const backlog = findBacklog(doc)!;
    expect(doc.get(kanban).text).toBe('Kanban');
    expect(doc.get(backlog).text).toBe('Backlog');
    expect(doc.get(backlog).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha']);
    checkInvariants(doc);
  });

  it('a second task in the same project adds nothing; a task right in Areas is its own', () => {
    const doc = build(para);
    task(doc, 'one');
    task(doc, 'two');
    task(doc, 'solo');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha', 'solo']);
  });

  it('the first level under a PARA folder is mirrored, however deep the task lies', () => {
    const doc = build(['PARA', '  Projects', '    Alpha', '      Phase', '        Step', '          deep']);
    task(doc, 'deep');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha']);
  });

  const mirror = (doc: Doc, parent: string, of: string, id = `m-${parent}`) =>
    doc.apply({
      t: 'insert', parent,
      node: { id, order: doc.orderAt(parent, doc.get(parent).children.length), text: '', note: '', collapsed: true, todo: false, done: false, created: 0, updated: 0, children: [], mirrorOf: of },
    });
  /** A bullet added inside `parent`, as typing it does. */
  const add = (doc: Doc, parent: string, id: string) => {
    const ops = doc.transact(() =>
      doc.apply({
        t: 'insert', parent,
        node: { id, order: doc.orderAt(parent, doc.get(parent).children.length), text: id, note: '', collapsed: false, todo: false, done: false, created: 0, updated: 0, children: [] },
      }),
    );
    return toBacklog(doc, backlogTargets(doc, ops));
  };

  it('a mirror in Week or Today, at any depth, keeps it there', () => {
    const doc = build([...para, 'Kanban', '  Backlog', '  Doing', '    Week', '      Wip']);
    mirror(doc, 'Wip', 'Alpha');
    task(doc, 'one');
    expect(doc.get('Backlog').children).toHaveLength(0);
    expect(doc.get('Wip').children).toHaveLength(1);
  });

  it('a mirror in another column goes back to the Backlog; one in the Backlog stays', () => {
    const doc = build([...para, 'Kanban', '  Backlog', '  Doing']);
    mirror(doc, 'Doing', 'Alpha');
    task(doc, 'one');
    expect(doc.get('Doing').children).toHaveLength(0);
    expect(doc.get('Backlog').children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha']);
    task(doc, 'two');
    expect(doc.get('Backlog').children).toHaveLength(1);
  });

  it('any bullet added in a first-level bullet brings it; one added right in a folder is a new first level', () => {
    const doc = build(para);
    expect(add(doc, 'Areas', 'fresh')).toBe(0);
    expect(findKanban(doc)).toBeNull();
    expect(add(doc, 'Alpha', 'three')).toBe(1);
    expect(add(doc, 'three', 'deeper')).toBe(0);
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha']);
  });

  it('moved within the same first level, a bullet brings nothing', () => {
    const doc = build(para);
    const ops = doc.transact(() => doc.apply({ t: 'move', id: 'two', from: { parent: 'Alpha', order: doc.get('two').order }, to: { parent: 'one', order: doc.orderAt('one', 0) } }));
    expect(backlogTargets(doc, ops)).toEqual([]);
  });

  it('finds them by place and word, with emoji and tags around', () => {
    const doc = build([...para, '🗂 KANBAN #board', '  ⏳ backlog @x', '  Doing']);
    task(doc, 'one');
    expect(findKanban(doc)).toBe('🗂 KANBAN #board');
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Alpha']);
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
    const doc = build([...para, 'Elsewhere', '  Beta', '    chore']);
    doc.apply({ t: 'setTodo', id: 'chore', from: false, to: true });
    expect(findKanban(doc)).toBeNull();
    const ops = doc.transact(() => doc.apply({ t: 'move', id: 'Beta', from: { parent: 'Elsewhere', order: doc.get('Beta').order }, to: { parent: 'Areas', order: doc.orderAt('Areas', 1) } }));
    toBacklog(doc, backlogTargets(doc, ops));
    expect(doc.get(findBacklog(doc)!).children.map((c) => doc.get(c).mirrorOf)).toEqual(['Beta']);
  });

  it('a #secret project is not mirrored', () => {
    const doc = build(['PARA', '  Projects', '    Hidden #secret', '      t']);
    task(doc, 't');
    expect(findKanban(doc)).toBeNull();
  });
});
