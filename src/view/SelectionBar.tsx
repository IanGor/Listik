import { Show } from 'solid-js';
import * as cmd from '../model/commands';
import { markdownOf } from '../model/outline-text';
import { nodeOf } from '../model/rows';
import type { Outliner } from './outliner';

/** The same block commands as the keyboard, reachable by touch and buttons. */
export function SelectionBar(props: { o: Outliner }) {
  const o = props.o;
  const roots = () => o.selectionRoots();
  const copy = () => navigator.clipboard?.writeText(markdownOf(o.doc, roots().map(nodeOf)))
    .then(() => o.notify('Скопировано'), () => o.notify('Не удалось скопировать'));
  return <Show when={o.selection()}>
    <div class="selectionbar" role="toolbar" aria-label="Выделенные пункты" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" data-action="SelectionBar.1" onClick={() => o.select(null)}>Готово</button>
      <span aria-live="polite">Выбрано: {o.selectedSet().size}</span>
      <button type="button" data-action="SelectionBar.2" onClick={() => {
        if (o.rows.length) o.select({ anchor: o.rows.ids[0], head: o.rows.ids[o.rows.length - 1] });
      }}>Выделить всё</button>
      <button type="button" data-action="SelectionBar.3" onClick={() => void copy()}>Копировать</button>
      <Show when={!o.readOnly}>
        <button type="button" data-action="SelectionBar.4" onClick={() => o.openMove(roots())}>Переместить в…</button>
        <button type="button" data-action="SelectionBar.5" onClick={() => o.run((ctx) => cmd.moveUpMany(ctx, roots()))}>Вверх</button>
        <button type="button" data-action="SelectionBar.6" onClick={() => o.run((ctx) => cmd.moveDownMany(ctx, roots()))}>Вниз</button>
        <button type="button" data-action="SelectionBar.7" onClick={() => o.run((ctx) => cmd.outdentMany(ctx, roots()))}>Вынести</button>
        <button type="button" data-action="SelectionBar.8" onClick={() => o.run((ctx) => cmd.indentMany(ctx, roots()))}>Вложить</button>
        <button type="button" data-action="SelectionBar.9" onClick={() => o.toggleTask(roots())}>Задача</button>
        <button type="button" data-action="SelectionBar.10" onClick={() => o.untask(roots())}>Убрать чекбоксы</button>
        <button type="button" data-action="SelectionBar.11" onClick={() => {
          const tasks = roots().filter((key) => o.contentOf(key).todo);
          if (tasks.length) o.toggleDone(tasks);
        }}>Выполнено</button>
        <button type="button" data-action="SelectionBar.12" class="destructive" onClick={() => o.deleteRows(roots())}>Удалить</button>
      </Show>
    </div>
  </Show>;
}
