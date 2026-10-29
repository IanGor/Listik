import { For, Show, createEffect, on } from 'solid-js';
import type { Outliner } from './outliner';
import { phone, touch } from './screen';

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = MAC ? '⌘' : 'Ctrl';
const ALT = MAC ? '⌥' : 'Alt';

/** What a finger does on a touch screen: [gesture, what it does]. */
const GESTURES: [gesture: string, action: string][] = [
  ['касание точки', 'войти в пункт (и в задачу: чекбокс стоит рядом с точкой)'],
  ['касание чекбокса', 'отметить выполненной / снять отметку'],
  ['удержание точки или строки', 'поднять пункт: повести — перетащить, отпустить на месте — меню (открыть, задача или отметка, заметка, переместить, удалить)'],
  ['строку влево до конца', 'удалить со всем вложенным (вернуть — в сообщении или в корзине)'],
  ['строку вправо до конца', 'поставить чекбокс; ещё раз — снять (отметки «выполнено» не ставит)'],
  ['стрелка в конце строки', 'свернуть / развернуть'],
  ['касание вертикальной линии', 'свернуть пункт, от которого она идёт'],
  ['касание #тега, @тега', 'искать этот тег'],
  ['касание [[ссылки]]', 'перейти в пункт, на который она ведёт'],
  ['панель над клавиатурой', 'при правке: вынести, вложить, переместить (вверх, вниз, куда…) | задача, заметка | # тег, [[ссылка]] | отменить, ещё (сегодня, зеркало, время, жирный, курсив, повторить, удалить)'],
  ['календарь и лоток в шапке', 'сегодня в календаре, Inbox'],
  ['«Главная» над списком', 'на главную; на главной — всё свернуть'],
];

/** Not keys but a pointer's doing, said in words rather than keycaps. */
interface Said {
  said: string;
}
const said = (words: string): Said => ({ said: words });

/** A long key breaks after a "+" when the column is narrow (a phone), never inside a name. */
const keycap = (key: string) => key.split('+').flatMap((part, i) => (i ? ['+', <wbr />, part] : [part]));

/** [keys, what they do]; keys separated by spaces render as separate keycaps. */
const GROUPS: [title: string, rows: [keys: string | Said, action: string][]][] = [
  ['Правка', [
    ['Enter', 'новый пункт / разделить строку'],
    ['Backspace', 'в начале строки — склеить с предыдущей; в пустом пункте с вложенными — выделить его, ещё раз — удалить'],
    [`${MOD}+Shift+Backspace`, 'удалить пункт с вложенными'],
    ['Shift+Enter', 'заметка под пунктом'],
    [`${MOD}+L`, 'задача: поставить чекбокс / убрать'],
    [`${MOD}+Enter`, 'отметить задачу выполненной / снять отметку (как клик по чекбоксу)'],
    [`${MOD}+Z ${MOD}+Shift+Z`, 'отменить / повторить'],
    [`${MOD}+B ${MOD}+I`, 'жирный / курсив: **так**, *так*'],
    ['/time', 'вставить текущее время, ЧЧ:ММ'],
    ['/template', 'вставить то, что внутри шаблона (пункта с тегом #template)'],
    ['/ # @', 'подсказка: команды / теги; ↑ ↓ и Enter — выбрать'],
    ['[[', 'ссылка на пункт: подсказка по названию; клик — перейти'],
    ['((', 'зеркало пункта (ромбик): тот же пункт здесь, правки общие; точка — к оригиналу'],
  ]],
  ['Структура', [
    ['Tab Shift+Tab', 'вложить / вынести'],
    [`${ALT}+Shift+↑ ${ALT}+Shift+↓`, 'переместить вверх / вниз'],
    [`${MOD}+Shift+M`, 'переместить в другое место по названию (и выделенные)'],
    [`${MOD}+${ALT}+← ${MOD}+${ALT}+→`, 'в дне календаря: предыдущий / следующий день'],
    [`${MOD}+↑ ${MOD}+↓`, 'свернуть / развернуть'],
    [said('клик по вертикальной линии'), 'свернуть пункт, от которого она идёт'],
    [said('клик по последней крошке'), 'свернуть весь первый уровень здесь; ещё раз — развернуть'],
  ]],
  ['Переходы', [
    ['↑ ↓', 'к соседнему пункту'],
    [`${ALT}+→ ${ALT}+←`, 'войти в пункт / выйти из него'],
    [`${MOD}+K`, 'перейти к пункту по названию; пусто — недавние места'],
    [said('«Сегодня», «Inbox» в шапке'), 'сегодняшний день в календаре, входящие'],
    [`${MOD}+Shift+Space`, 'записать мысль в Inbox, не уходя с места'],
    ['Esc', 'сбросить поиск, затем выйти из редактирования'],
  ]],
  ['Поиск', [
    [`${MOD}+F`, 'к строке поиска'],
    ['Enter', 'к первому найденному'],
    ['"фраза"', 'целиком'],
    ['-слово -#тег', 'исключить'],
    ['OR', 'или'],
    ['is:todo is:done', 'открытые / выполненные задачи'],
    ['is:task', 'все задачи'],
  ]],
  ['Выделение', [
    ['Shift+↑ Shift+↓', 'выделить текст до края, весь текст, затем пункт с вложенными и соседние пункты'],
    ['Shift+клик', 'выделить диапазон'],
    [`${MOD}+C ${MOD}+X`, 'скопировать / вырезать как Markdown'],
    [`${MOD}+A`, 'весь текст, ещё раз — пункт, ещё раз — всё видимое'],
  ]],
];

/**
 * The keyboard shortcuts, grouped by task (`?`, Ctrl+/ or the menu). On a
 * touch screen the gestures come first; the keys still work with a keyboard
 * attached.
 */
export function Shortcuts(props: { o: Outliner }) {
  let dialog!: HTMLDialogElement;
  const title = () => (phone() ? 'Жесты и клавиши' : 'Горячие клавиши');
  createEffect(on(props.o.helpRequests, () => {
    if (!dialog.open) dialog.showModal();
  }, { defer: true }));

  return (
    <dialog
      ref={dialog}
      class="shortcuts"
      aria-label={title()}
      // A click on the backdrop (the dialog element itself, outside its content) closes it.
      onClick={(e) => e.target === dialog && dialog.close()}
    >
      {/* Focus lands on the panel itself, not on the close button. */}
      <div class="shortcuts-body" tabIndex={-1} autofocus>
        <div class="shortcuts-head">
          <h2>{title()}</h2>
          <button type="button" class="icon-button" aria-label="Закрыть" onClick={() => dialog.close()}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
            </svg>
          </button>
        </div>
        <div class="shortcuts-groups">
          <Show when={touch()}>
            <section>
              <h3>Касания</h3>
              <dl>
                <For each={GESTURES}>
                  {([gesture, action]) => (
                    <>
                      <dt class="gesture">{gesture}</dt>
                      <dd>{action}</dd>
                    </>
                  )}
                </For>
              </dl>
            </section>
          </Show>
          <For each={GROUPS}>
            {([title, rows]) => (
              <section>
                <h3>{title}</h3>
                <dl>
                  <For each={rows}>
                    {([keys, action]) => (
                      <>
                        {typeof keys === 'string' ? (
                          <dt>
                            <For each={keys.split(' ')}>{(k) => <kbd>{keycap(k)}</kbd>}</For>
                          </dt>
                        ) : (
                          <dt class="gesture">{keys.said}</dt>
                        )}
                        <dd>{action}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
      </div>
    </dialog>
  );
}
