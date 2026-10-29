import { describe, expect, it } from 'vitest';
import { projectTags } from '../src/model/projects';
import { build } from './helpers';

describe('projectTags', () => {
  it('signs bullets marked @work or @home, in text or note, and leaves tasks, tagged ones and the rest', () => {
    const doc = build(['PBR @work', 'Flat @home', 'Done #project @work', 'Plain', 'Other @x']);
    doc.apply({ t: 'setNote', id: 'Plain', from: '', to: '@work', at: 1 });
    doc.apply({ t: 'setTodo', id: 'Flat @home', from: false, to: true });
    const fixes = projectTags(doc).sort((a, b) => a.id.localeCompare(b.id));
    expect(fixes).toEqual([
      { id: 'PBR @work', field: 'text', to: 'PBR @work #project' },
      { id: 'Plain', field: 'note', to: '@work #project' },
    ]);
  });
});
