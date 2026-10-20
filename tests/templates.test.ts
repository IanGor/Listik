import { describe, expect, it } from 'vitest';
import * as cmd from '../src/model/commands';
import { checkInvariants } from '../src/model/invariants';
import { TagIndex } from '../src/model/tags';
import { asksTemplate, findTemplates, insertTemplate, matchTemplates, templateTitle, templateTree } from '../src/model/templates';
import { dump, setup } from './helpers';

const lines = [
  'Встреча #template',
  '  Повестка',
  '    вопрос',
  '  Итоги',
  'Проект',
  '  #template **Ретро** спринта',
  '    Что было хорошо',
  'про #templates и заметка',
  'место',
  '  пустой',
  '  текст',
];

/** `setup` with the two bullets under "место" given their `/template` text (an id may not hold "/"). */
function withTokens() {
  const s = setup(lines);
  s.run(() => {
    s.doc.apply({ t: 'setText', id: 'пустой', from: 'пустой', to: '/template' });
    s.doc.apply({ t: 'setText', id: 'текст', from: 'текст', to: 'уже текст /template тут' });
  });
  return s;
}

describe('templates', () => {
  it('are bullets tagged #template, in document order, named by their text without the tag', () => {
    const { doc } = withTokens();
    const tags = new TagIndex(doc);
    expect(findTemplates(doc, tags)).toEqual([
      { id: 'Встреча #template', title: 'Встреча' },
      { id: '#template **Ретро** спринта', title: 'Ретро спринта' },
    ]);
    expect(templateTitle('#template')).toBe('');
    expect(templateTitle('a #TEMPLATE b')).toBe('a b');
  });

  it('a mention in a note makes no template; a deleted one is gone', () => {
    const { doc, ctx, run } = setup(['a', 'б #template']);
    run(() => cmd.setNote(ctx, 'a', 'см. #template'));
    const tags = new TagIndex(doc);
    expect(findTemplates(doc, tags).map((t) => t.id)).toEqual(['б #template']);
    run(() => cmd.deleteNode(ctx, 'б #template'));
    expect(findTemplates(doc, tags)).toEqual([]);
  });

  it('matches /, /t…, /template and a name, and says when there are none', () => {
    const list = [{ id: 'a', title: 'Встреча' }, { id: 'b', title: 'Ретро спринта' }];
    expect(matchTemplates(list, '', 8).map((t) => t.id)).toEqual(['a', 'b']);
    expect(matchTemplates(list, 'temp', 8).map((t) => t.id)).toEqual(['a', 'b']);
    expect(matchTemplates(list, 'templateретро', 8).map((t) => t.id)).toEqual(['b']);
    expect(matchTemplates(list, 'встр', 8).map((t) => t.id)).toEqual(['a']);
    expect(matchTemplates(list, 'time', 8)).toEqual([]);
    expect(matchTemplates(list, '', 1)).toHaveLength(1);
    expect(asksTemplate('te')).toBe(true);
    expect(asksTemplate('t')).toBe(false);
    expect(asksTemplate('templateх')).toBe(true);
    expect(asksTemplate('ti')).toBe(false);
  });

  it('copies the whole template, its name for the text, tasks unchecked', () => {
    const { doc, ctx, run } = setup(['Чек #template', '  пункт']);
    run(() => cmd.cycleTask(ctx, ['пункт']));
    run(() => cmd.toggleDone(ctx, ['пункт']));
    const t = templateTree(doc, 'Чек #template');
    expect(t).toEqual({ text: 'Чек', note: '', todo: false, children: [{ text: 'пункт', note: '', todo: true, children: [] }] });
  });

  it('puts in what is inside it, at the row\'s level and without its own bullet: from an empty row, or after a row with text', () => {
    const { doc, ctx, run } = withTokens();
    expect(run(() => insertTemplate(ctx, 'пустой', 'Встреча #template', 0, 9))).toEqual({ id: 'пустой', caret: 8 });
    const g = run(() => insertTemplate(ctx, 'текст', 'Встреча #template', 10, 19))!;
    expect(dump(doc).slice(-8)).toEqual([
      'место',
      '  Повестка',
      '    вопрос',
      '  Итоги',
      '  уже текст  тут',
      '  Повестка',
      '    вопрос',
      '  Итоги',
    ]);
    expect(doc.get(g.id).text).toBe('Повестка');
    expect(g.caret).toBe(8);
    expect(dump(doc).join('\n')).not.toContain('Встреча\n    Повестка');
    // The template itself stays as it was.
    expect(dump(doc).slice(0, 4)).toEqual(lines.slice(0, 4));
    checkInvariants(doc);
  });

  it('a template with nothing inside only takes the token out', () => {
    const { doc, ctx, run } = setup(['Пусто #template', 'место']);
    run(() => doc.apply({ t: 'setText', id: 'место', from: 'место', to: 'а /template' }));
    expect(run(() => insertTemplate(ctx, 'место', 'Пусто #template', 2, 11))).toBeNull();
    expect(dump(doc)).toEqual(['Пусто #template', 'а ']);
  });
});
