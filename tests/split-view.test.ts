// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'solid-js';
import { Outliner } from '../src/view/outliner';
import { build } from './helpers';

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function session(readOnly = false) {
  return createRoot(dispose => {
    const doc = build(['A', '  child', 'B']);
    const first = new Outliner(doc, { readOnly });
    const second = first.forkView();
    stops.push(() => { second.disposeView(); first.disposeView(); first.tags.dispose(); first.text.dispose(); first.tasks.dispose(); dispose(); });
    return { doc, first, second };
  });
}

describe('split document views', () => {
  it('shares document resources and history, but not navigation, search or focus', () => {
    const { first, second } = session();
    for (const key of ['doc', 'history', 'nodes', 'tags', 'text', 'tasks', 'favorites'] as const) expect(second[key]).toBe(first[key]);
    second.zoomTo('A');
    second.setQuery('child', true);
    second.setFocus({ id: 'child', caret: 2 });
    expect(first.zoom()).toBeNull();
    expect(first.query()).toBe('');
    expect(first.focus()).toBeNull();
    expect(second.zoom()).toBe('A');
  });

  it('undoes and redoes peer edits in one document history', () => {
    const { doc, first, second } = session();
    first.type('A', 'first');
    second.typeNote('B', 'second pane note');
    expect(doc.get('B').note).toBe('second pane note');
    first.undo();
    expect(doc.get('B').note).toBe('');
    expect(doc.get('A').text).toBe('first');
    second.undo();
    expect(doc.get('A').text).toBe('A');
    first.redo();
    expect(doc.get('A').text).toBe('first');
  });

  it('keeps split folds local and copies/restores them without document operations', () => {
    const { doc, first, second } = session();
    first.rows.isolateFolds(); second.rows.isolateFolds();
    first.fold('A', true);
    expect(first.rows.ids).toEqual(['A', 'B']);
    expect(second.rows.ids).toEqual(['A', 'child', 'B']);
    expect(doc.get('A').collapsed).toBe(false);
    expect(first.history.canUndo).toBe(false);
    second.rows.isolateFolds(first.rows.paneFoldEntries());
    expect(second.rows.ids).toEqual(['A', 'B']);
    second.fold('A', false);
    expect(first.rows.ids).toEqual(['A', 'B']);
    expect(second.rows.ids).toEqual(['A', 'child', 'B']);
    second.rows.releasePaneFolds(true);
    first.rows.releasePaneFolds();
    second.fold('A', true);
    expect(doc.get('A').collapsed).toBe(true);
    expect(first.history.canUndo).toBe(true);
  });

  it('does not grant write permission to a second view', () => {
    const { doc, first, second } = session(true);
    second.type('A', 'blocked');
    second.typeNote('A', 'blocked');
    expect(doc.get('A').text).toBe('A');
    expect(doc.get('A').note).toBe('');
    expect(first.history.canUndo).toBe(false);
  });
});
