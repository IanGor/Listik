import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import type { Doc } from '../src/model/doc';
import { findTargets, resolveLink } from '../src/model/links';
import { findPlaces } from '../src/model/places';
import { keepSet } from '../src/model/rows';
import { TextIndex, findMatches, parseQuery } from '../src/model/search';
import { TagIndex, isSecret, searchable } from '../src/model/tags';
import { rng, setup } from './helpers';

const lines = [
  'Работа #план',
  '  Отчёт #план',
  'Дневник #secret',
  '  Мечты #план',
  '    Остров',
  'Остров мечты',
];

const env = (l = lines) => {
  const e = setup(l);
  return { ...e, tags: new TagIndex(e.doc), text: new TextIndex(e.doc) };
};
type Env = ReturnType<typeof env>;
const find = (e: Env, q: string) => [...findMatches(parseQuery(q), e.tags, e.text, e.doc)].sort();
const counts = (tags: TagIndex) => [...tags.counts()].sort(([a], [b]) => a.localeCompare(b));

describe('#secret', () => {
  it('is read in the text or the note, any case, and not as a longer tag or a word', () => {
    expect(isSecret({ text: 'Дневник #Secret', note: '' })).toBe(true);
    expect(isSecret({ text: 'Дневник', note: 'личное #secret' })).toBe(true);
    expect(isSecret({ text: '(#secret)', note: '' })).toBe(true);
    for (const text of ['#secret-план', '#secrets', 'a#secret', 'secret', '@secret']) {
      expect(isSecret({ text, note: '' }), text).toBe(false);
    }
  });

  it('hides the bullet and all inside it from search, the tag filter and tag suggestions', () => {
    const e = env();
    expect(find(e, '#план')).toEqual(['Отчёт #план', 'Работа #план']);
    expect(find(e, 'остров')).toEqual(['Остров мечты']);
    expect(find(e, 'дневник')).toEqual([]);
    expect(find(e, '#secret')).toEqual([]);
    expect(find(e, '#s')).toEqual([]);
    expect(find(e, '-#план')).toEqual(['Остров мечты']);
    expect(counts(e.tags)).toEqual([['план', 2]]);
    expect(searchable(e.doc, 'Работа #план')).toBe(true);
    expect(searchable(e.doc, 'Дневник #secret')).toBe(false);
    expect(searchable(e.doc, 'Остров')).toBe(false);
  });

  it('follows #secret typed and erased, in the text and in the note, and bullets moved in and out', () => {
    const e = env();
    const { ctx, run } = e;
    e.text.warmUp();
    run(() => cmd.setText(ctx, 'Работа #план', 'Работа #план #secret'));
    expect(find(e, '#план')).toEqual([]);
    expect(find(e, 'отчёт')).toEqual([]);
    run(() => cmd.setText(ctx, 'Работа #план', 'Работа #план'));
    expect(find(e, '#план')).toEqual(['Отчёт #план', 'Работа #план']);

    run(() => cmd.setNote(ctx, 'Отчёт #план', 'черновик #secret'));
    expect(find(e, '#план')).toEqual(['Работа #план']);
    run(() => cmd.setNote(ctx, 'Дневник #secret', 'ещё одна заметка'));
    expect(find(e, 'заметка')).toEqual([]);
    run(() => cmd.setText(ctx, 'Дневник #secret', 'Дневник'));
    // Erased: the bullet, its note and its inside are found again.
    expect(find(e, 'дневник')).toEqual(['Дневник #secret']);
    expect(find(e, 'заметка')).toEqual(['Дневник #secret']);
    expect(find(e, 'остров')).toEqual(['Остров', 'Остров мечты']);
    run(() => cmd.setText(ctx, 'Дневник #secret', 'Дневник #secret'));

    run(() => cmd.indent(ctx, 'Остров мечты'));
    expect(find(e, 'остров')).toEqual([]);
    run(() => cmd.outdent(ctx, 'Остров мечты'));
    expect(find(e, 'остров')).toEqual(['Остров мечты']);
  });

  it('is never linked to, mirrored or offered as a place', () => {
    const { doc, text } = env();
    expect(resolveLink(doc, text, 'Остров')).toBeNull();
    expect(resolveLink(doc, text, 'Дневник #secret')).toBeNull();
    expect(findTargets(doc, text, 'остров', '', 10).map((t) => t.id)).toEqual(['Остров мечты']);
    // Nothing typed: by recency, straight from the doc's nodes.
    expect(findTargets(doc, text, '', '', 10).map((t) => t.id).sort()).toEqual(['Остров мечты', 'Отчёт #план', 'Работа #план']);
    expect(findPlaces(doc, text, 'мечт', 10).map((p) => p.id)).toEqual(['Остров мечты']);
    expect(findPlaces(doc, text, 'днев', 10)).toEqual([]);
  });

  it('keeps a copy inside a secret bullet off the paths search shows', () => {
    const paths = (secret: string) => {
      const { doc, ctx, run } = setup(['Пьер', `Дневник${secret}`, '  копия']);
      run(() => cmd.setText(ctx, 'копия', '((Пьер))'));
      run(() => cmd.makeMirror(ctx, 'копия', 'Пьер', 0, 8));
      return [...keepSet(doc, ['Пьер'])].sort();
    };
    expect(paths('')).toEqual(['root', 'Пьер', 'Дневник', 'копия'].sort());
    expect(paths(' #secret')).toEqual(['root', 'Пьер'].sort());
  });

  it('keeps the indexes equal to freshly built ones through random edits, also mid-build', () => {
    const base = ['а #x', '  б', '    в #x', '  г', 'д', '  е #x', '    ж'];
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
      const e = env(base);
      const { doc, rows, ctx } = e;
      if (seed % 3 === 0) e.text.warmUp();
      else if (seed % 3 === 1) startIdleBuild(e.text);
      let steps = 0;
      for (let step = 0; step < 150 && rows.ids.length; step++) {
        const id = pick(rows.ids);
        const n = doc.get(id);
        const action = pick([
          () => cmd.setText(ctx, id, n.text.includes(' #secret') ? n.text.replace(' #secret', '') : n.text + ' #secret'),
          () => cmd.setNote(ctx, id, n.note ? '' : pick(['тайна #secret', 'просто #x'])),
          () => cmd.setText(ctx, id, n.text + pick([' #x', ' слово'])),
          () => cmd.indent(ctx, id),
          () => cmd.outdent(ctx, id),
          () => cmd.split(ctx, id, n.text.length),
          () => rand() < 0.3 && cmd.deleteNode(ctx, id),
        ]);
        doc.transact(() => { action(); });
        steps++;
      }
      expect(steps, `seed ${seed}`).toBeGreaterThan(100);
      const fresh = { tags: new TagIndex(doc), text: new TextIndex(doc) };
      expect(counts(e.tags), `seed ${seed}`).toEqual(counts(fresh.tags));
      for (const q of [[''], ['#x'], ['слово']]) {
        expect([...e.text.find(q)].sort(), `seed ${seed} ${q}`).toEqual([...fresh.text.find(q)].sort());
      }
      expect(findable(doc, e)).toEqual(findable(doc, fresh));
    }
  });
});

/** Every bullet search finds, checked against `searchable` bullet by bullet. */
function findable(doc: Doc, e: { text: TextIndex }): string[] {
  const found = [...e.text.find([''])].filter((id) => id !== doc.root).sort();
  const expected = [...doc.nodes.keys()].filter((id) => id !== doc.root && searchable(doc, id)).sort();
  expect(found).toEqual(expected);
  return found;
}

/** Starts a TextIndex build in idle time that gets no time at all: every bullet stays pending. */
function startIdleBuild(text: TextIndex): void {
  let budget = 1;
  (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (fn: (d: IdleDeadline) => void) =>
    budget-- > 0 && fn({ timeRemaining: () => 0, didTimeout: false } as IdleDeadline);
  try {
    text.warmUpInIdle();
  } finally {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  }
}
