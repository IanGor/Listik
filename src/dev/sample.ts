import { generateKeyBetween } from 'fractional-indexing';
import { indent, outdent, setText, split } from '../model/commands';
import { Doc } from '../model/doc';
import { VisibleRows } from '../model/rows';
import type { NodeSnapshot } from '../model/types';
import { rng } from '../util/rng';

const DEMO: [depth: number, text: string][] = [
  [0, 'Том первый'],
  [1, 'Часть первая'],
  [2, '— Eh bien, mon prince. Gênes et Lucques ne sont plus que des apanages… #салон'],
  [2, 'Так говорила в июле 1805 года известная Анна Павловна Шерер #шерер'],
  [1, 'Часть вторая'],
  [0, 'Том второй'],
];

/** A small outline, built through the real commands the same way typing does. */
export function demoDoc(): Doc {
  const doc = Doc.withEmptyBullet();
  const rows = new VisibleRows(doc);
  const ctx = { doc, rows };
  doc.transact(() => {
    let id = rows.ids[0];
    let depth = 0;
    DEMO.forEach(([d, text], i) => {
      if (i > 0) id = split(ctx, id, doc.get(id).text.length).id;
      for (; depth < d; depth++) indent(ctx, id);
      for (; depth > d; depth--) outdent(ctx, id);
      setText(ctx, id, text);
    });
  });
  rows.dispose();
  return doc;
}

const WORDS = (
  'князь Андрей Пьер Наташа Ростов Болконский война мир Москва Петербург бал салон армия Кутузов ' +
  'Наполеон Бородино граф графиня письмо вечер утро поле небо солдат офицер говорил сказал думал ' +
  'смотрел улыбнулся тихо быстро вдруг опять никогда всегда жизнь любовь смерть счастье дом'
).split(' ');
const TAGS = ['#пьер', '#наташа', '#андрей', '#война', '#бал', '#важно'];

/**
 * Synthetic outline for trying the UI at scale (`?sample=200000`):
 * chapters of ~200 bullets, a fifth of them with 1–3 children, some long
 * enough to wrap, ~10% tagged. Built with one insert per chapter.
 */
export function sampleDoc(count: number, seed = 1): Doc {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const sentence = () => {
    const words = rand() < 0.05 ? 20 + rand() * 40 : 2 + rand() * 5;
    const out: string[] = [];
    for (let i = 0; i < words; i++) out.push(pick(WORDS));
    if (rand() < 0.1) out.push(pick(TAGS));
    return out.join(' ');
  };
  const now = Date.now();
  const node = (text: string, prev: string | null): NodeSnapshot => ({
    id: crypto.randomUUID(), order: generateKeyBetween(prev, null), text,
    collapsed: false, created: now, updated: now, children: [],
  });
  const lastOrder = (xs: NodeSnapshot[]) => (xs.length ? xs[xs.length - 1].order : null);

  const doc = new Doc();
  let made = 0;
  let prevChapter: string | null = null;
  for (let c = 1; made < count; c++) {
    const chapter = node(`Глава ${c}`, prevChapter);
    prevChapter = chapter.order;
    made++;
    for (let p = 0; p < 200 && made < count; p++) {
      const para = node(sentence(), lastOrder(chapter.children));
      chapter.children.push(para);
      made++;
      if (rand() < 0.2) {
        for (let k = 1 + Math.floor(rand() * 3); k > 0 && made < count; k--) {
          para.children.push(node(sentence(), lastOrder(para.children)));
          made++;
        }
      }
    }
    doc.apply({ t: 'insert', parent: doc.root, node: chapter });
  }
  return doc;
}
