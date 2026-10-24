import { describe, expect, it } from 'vitest';
import { indent, setNote, setText, sinkDone, split, toggleDone } from '../src/model/commands';
import { History, focusAfter } from '../src/model/history';
import { dump, setup } from './helpers';

/** Types `text` into bullet `id` one character at a time, `gap` ms apart. */
function typeInto(env: ReturnType<typeof setup>, history: History, id: string, text: string, start = 0, gap = 100) {
  let now = start;
  for (const ch of text) {
    const ops = env.doc.transact(() => setText(env.ctx, id, env.doc.get(id).text + ch));
    history.record({ ops, before: null, after: null }, { typing: true, now });
    now += gap;
  }
  return now;
}

describe('History', () => {
  it('a step still the last one takes more ops into its undo; once another came, it does not', () => {
    const env = setup(['a', 'b', 'c']);
    const history = new History();
    const check = env.doc.transact(() => toggleDone(env.ctx, ['a']));
    history.record({ ops: check, before: null, after: null });
    const sunk = env.doc.transact(() => sinkDone(env.ctx, ['a']));
    expect(history.extend(check, sunk)).toBe(true);
    expect(check).toHaveLength(1);
    expect(dump(env.doc)).toEqual(['b', 'c', 'a']);
    history.undo(env.doc);
    expect(dump(env.doc)).toEqual(['a', 'b', 'c']);
    expect(env.doc.get('a').done).toBe(false);
    const again = env.doc.transact(() => toggleDone(env.ctx, ['a']));
    history.record({ ops: again, before: null, after: null });
    history.record({ ops: env.doc.transact(() => setText(env.ctx, 'b', 'bb')), before: null, after: null });
    expect(history.extend(again, env.doc.transact(() => sinkDone(env.ctx, ['a'])))).toBe(false);
  });

  it('groups a typed word into one step and puts the caret back where typing started', () => {
    const env = setup(['x']);
    const history = new History();
    typeInto(env, history, 'x', 'abc');
    const e = history.undo(env.doc)!;
    expect(dump(env.doc)).toEqual(['x']);
    expect(focusAfter(e, false)).toEqual({ id: 'x', caret: 1 });
    expect(history.canUndo).toBe(false);
    const r = history.redo(env.doc)!;
    expect(dump(env.doc)).toEqual(['xabc']);
    expect(focusAfter(r, true)).toEqual({ id: 'x', caret: 4 });
  });

  it('starts a new step at a new word and after a pause', () => {
    const env = setup(['']);
    const history = new History();
    const t = typeInto(env, history, '', 'hello world');
    typeInto(env, history, '', '!', t + 5000);
    history.undo(env.doc);
    expect(dump(env.doc)).toEqual(['hello world']);
    history.undo(env.doc);
    expect(dump(env.doc)).toEqual(['hello ']);
    history.undo(env.doc);
    expect(dump(env.doc)).toEqual(['']);
  });

  it('undoes structural commands and restores focus to where the command started', () => {
    const env = setup(['ab', 'c']);
    const history = new History();
    const ops = env.doc.transact(() => { split(env.ctx, 'ab', 1); });
    history.record({ ops, before: { id: 'ab', caret: 1 }, after: null });
    const ops2 = env.doc.transact(() => indent(env.ctx, 'c'));
    history.record({ ops: ops2, before: { id: 'c', caret: 0 }, after: { id: 'c', caret: 0 } });
    expect(dump(env.doc)).toEqual(['a', 'b', '  c']);

    expect(focusAfter(history.undo(env.doc)!, false)).toEqual({ id: 'c', caret: 0 });
    expect(focusAfter(history.undo(env.doc)!, false)).toEqual({ id: 'ab', caret: 1 });
    expect(dump(env.doc)).toEqual(['ab', 'c']);
    history.redo(env.doc);
    history.redo(env.doc);
    expect(dump(env.doc)).toEqual(['a', 'b', '  c']);
  });

  it('drops the redo stack on a new change and ignores empty batches', () => {
    const env = setup(['a']);
    const history = new History();
    typeInto(env, history, 'a', 'b');
    history.undo(env.doc);
    expect(history.canRedo).toBe(true);
    history.record({ ops: [], before: null, after: null });
    expect(history.canRedo).toBe(true);
    typeInto(env, history, 'a', 'c');
    expect(history.canRedo).toBe(false);
  });

  it('does not extend a typing step after undo', () => {
    const env = setup(['']);
    const history = new History();
    typeInto(env, history, '', 'ab');
    typeInto(env, history, '', ' cd', 300);
    history.undo(env.doc);
    typeInto(env, history, '', 'x', 600);
    history.undo(env.doc);
    expect(dump(env.doc)).toEqual(['ab ']);
  });
});

describe('History of notes', () => {
  it('groups note typing per word and puts the caret back into the note', () => {
    const env = setup(['x']);
    const history = new History();
    let now = 0;
    for (const ch of 'abc') {
      const ops = env.doc.transact(() => setNote(env.ctx, 'x', env.doc.get('x').note + ch));
      history.record({ ops, before: null, after: null }, { typing: true, now: (now += 100) });
    }
    const e = history.undo(env.doc)!;
    expect(env.doc.get('x').note).toBe('');
    expect(focusAfter(e, false)).toEqual({ id: 'x', caret: 0, note: true });
  });
});
