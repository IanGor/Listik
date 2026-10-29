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
