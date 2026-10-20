import { For, Show, createEffect, on } from 'solid-js';
import type { Outliner } from './outliner';
import { touch } from './screen';

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = MAC ? '⌘' : 'Ctrl';
const ALT = MAC ? '⌥' : 'Alt';

/** What a finger does on a touch screen: [gesture, what it does]. */
const GESTURES: [gesture: string, action: string][] = [
  ['касание точки', 'войти в пункт; у задачи — отметить'],
  ['удержание точки', 'поднять пункт и перетащить'],
  ['стрелка слева', 'свернуть / развернуть'],
  ['касание #тега, @тега', 'искать этот тег'],
  ['касание [[ссылки]]', 'перейти в пункт, на который она ведёт'],
  ['панель внизу', 'при правке: вынести, вложить, вверх, вниз, задача, заметка, жирный, курсив, время, отменить, повторить'],
  ['знак Listik', 'сегодня в календаре'],
  ['«Главная» над списком', 'на главную; на главной — всё свернуть'],
];

/** [keys, what they do]; keys separated by spaces render as separate keycaps. */
const GROUPS: [title: string, rows: [keys: string, action: string][]][] = [
  ['Правка', [
    ['Enter', 'новый пункт / разделить строку'],
    ['Backspace', 'в начале строки — склеить с предыдущей'],
    [`${MOD}+Shift+Backspace`, 'удалить пункт с вложенными'],
    ['Shift+Enter', 'заметка под пунктом'],
    [`${MOD}+L`, 'по кругу: сделать задачей (чекбокс), отметить, снова обычный пункт; клик по чекбоксу — отметить / снять отметку'],
    [`${MOD}+Shift+L`, 'задачу — снова в обычный пункт'],
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
    [`${MOD}+↑ ${MOD}+↓`, 'свернуть / развернуть'],
    ['клик по вертикальной линии', 'свернуть пункт, от которого она идёт'],
    ['клик по последней крошке', 'свернуть весь первый уровень здесь; ещё раз — развернуть'],
  ]],
  ['Переходы', [
    ['↑ ↓', 'к соседнему пункту'],
    [`${ALT}+→ ${ALT}+←`, 'войти в пункт / выйти из него'],
    ['знак Listik', 'сегодня в календаре'],
    [`${MOD}+Shift+Space`, 'записать мысль в Inbox, не уходя с места'],
    [`${MOD}+${ALT}+← ${MOD}+${ALT}+→`, 'в календаре: предыдущий / следующий день, неделя, месяц, квартал'],
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
    ['Shift+↑ Shift+↓', 'на краю строки — выделить пункты'],
    ['Shift+клик', 'выделить диапазон'],
    [`${MOD}+C ${MOD}+X`, 'скопировать / вырезать как Markdown'],
    [`${MOD}+A`, 'выделить всё видимое'],
  ]],
];

/**
 * The keyboard shortcuts, grouped by task (`?`, Ctrl+/ or the menu). On a
 * touch screen the gestures come first; the keys still work with a keyboard
 * attached.
 */
export function Shortcuts(props: { o: Outliner }) {
  let dialog!: HTMLDialogElement;
  const title = () => (touch() ? 'Жесты и клавиши' : 'Горячие клавиши');
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
                        <dt>
                          <For each={keys.split(' ')}>{(k) => <kbd>{k}</kbd>}</For>
                        </dt>
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
