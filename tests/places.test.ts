import { describe, expect, it } from 'vitest';
import { findPlaces, pathOf } from '../src/model/places';
import { TextIndex } from '../src/model/search';
import { build } from './helpers';

describe('places', () => {
  const doc = build(['Projects', '  **Listik**', '    Listik promo', '  Дача', 'Inbox', '  идея для листика']);
  const index = new TextIndex(doc);

  it('finds bullets by title, the title first, with the path above them', () => {
    doc.apply({ t: 'setText', id: 'идея для листика', from: 'идея для листика', to: 'идея для listik' });
    expect(findPlaces(doc, index, 'listik', 5)).toEqual([
      { id: '**Listik**', title: 'Listik', path: ['Projects'] },
      { id: 'Listik promo', title: 'Listik promo', path: ['Projects', 'Listik'] },
      { id: 'идея для листика', title: 'идея для listik', path: ['Inbox'] },
    ]);
    expect(pathOf(doc, 'Projects')).toEqual([]);
  });

  it('leaves out what `skip` rules out, still giving as many as asked', () => {
    const skip = (id: string) => id === '**Listik**' || id === 'Listik promo';
    expect(findPlaces(doc, index, 'listik', 1, skip).map((p) => p.id)).toEqual(['идея для листика']);
  });
});
