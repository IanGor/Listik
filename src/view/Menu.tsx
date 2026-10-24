import { Match, Show, Switch, createSignal, onCleanup, type JSX } from 'solid-js';
import { appendTrees } from '../model/commands';
import { countTrees, looksLikeOpml, parseIndented, parseOpml, toMarkdown, toOpml } from '../model/outline-text';
import type { BackupStatus } from '../persist/backup';
import { plural } from '../util/plural';
import { dateStamp, download, pickFile } from './files';
import type { Outliner } from './outliner';
import { touch } from './screen';
import { describeSync, syncState } from './SyncDialog';
import { TEXT_SCALES, stepTextScale, textScale } from './textsize';
import { theme, toggleTheme } from './theme';

/**
 * A menu item's symbol, at the end of its line as in Apple's menus: thin
 * line drawings in the manner of SF Symbols, the text's colour.
 */
export function Symbol(props: { children: JSX.Element }) {
  return (
    <svg class="menu-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

const GO = () => <Symbol><circle cx="12" cy="12" r="9" /><path d="M8 12h8M13 8.5l3.5 3.5-3.5 3.5" /></Symbol>;
// A note being written (square.and.pencil): the tray is the header's Inbox, a place, not this action.
const WRITE = () => <Symbol><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" /></Symbol>;
const SAVE = () => <Symbol><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3" /></Symbol>;
const OPEN = () => <Symbol><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 17v-6M9 14l3-3 3 3" /></Symbol>;
const KEYS = () => <Symbol><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" /></Symbol>;
const MOON = () => <Symbol><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></Symbol>;
const CHECK = () => <Symbol><path d="M5 12.5l4.5 4.5L19 7.5" /></Symbol>;
const TRASH = () => <Symbol><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Symbol>;
const CALENDAR = () => <Symbol><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Symbol>;
const CLOUD = () => <Symbol><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 0 0 4.6 12.6 3.5 3.5 0 0 0 6.5 19z" /></Symbol>;
const FOLDER = () => <Symbol><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Symbol>;

const time = (t?: number) => (t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * The document menu: export, import, automatic copies into a folder, the
 * theme switch and sync. Its button carries a dot while changes wait for the
 * server or the connection is lost.
 */
export function DocumentMenu(props: { o: Outliner }) {
  const o = props.o;
  const [open, setOpen] = createSignal(false);
  const [backup, setBackup] = createSignal<BackupStatus | null>(o.backup?.status ?? null);
  if (o.backup) onCleanup(o.backup.subscribe(setBackup));
  let root!: HTMLDivElement;

  const close = () => setOpen(false);
  const onPointerDown = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);
  onCleanup(() => {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeyDown);
  });

  const exportAs = (kind: 'md' | 'opml') => {
    close();
    if (kind === 'md') download(`listik-${dateStamp()}.md`, 'text/markdown', toMarkdown(o.doc));
    else download(`listik-${dateStamp()}.opml`, 'text/x-opml', toOpml(o.doc));
  };

  const importFile = async () => {
    close();
    const file = await pickFile('.md,.markdown,.txt,.opml,.xml');
    if (!file) return;
    const text = await file.text();
    try {
      const trees = looksLikeOpml(text) ? parseOpml(text) : parseIndented(text);
      const n = countTrees(trees);
      if (!n) return o.notify('В файле нет пунктов');
      o.run((ctx) => appendTrees(ctx, o.rows.top, trees));
      o.notify(`Импортировано ${n.toLocaleString('ru-RU')} ${plural(n, 'пункт', 'пункта', 'пунктов')} из «${file.name}»`);
    } catch (e) {
      o.notify(`Не удалось импортировать «${file.name}»: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** The sync state worth a dot on the button; none when in step or off. */
  const syncAlert = () => {
    if (!o.syncing()) return null;
    const state = syncState(o.syncStatus());
    return state === 'synced' ? null : state;
  };

  const act = (fn: () => Promise<void> | undefined) => () => {
    close();
    void fn()?.catch((e: unknown) => {
      // Cancelling the folder picker is not an error worth showing.
      if (!(e instanceof DOMException && e.name === 'AbortError')) o.notify(`Автокопия: ${String(e)}`);
    });
  };

  return (
    <div class="menu-anchor" ref={root}>
      <button
        type="button"
        class="icon-button menu-button"
        title={o.syncing() ? `Документ. ${describeSync(o.syncStatus())}` : 'Документ: экспорт, импорт, тема, синхронизация'}
        aria-label="Меню документа"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
        <Show when={syncAlert()}>{(state) => <span class={`sync-dot sync-${state()}`} />}</Show>
      </button>
      <Show when={open()}>
        <div class="menu" role="menu">
          {/* Going to a place by its name is a computer's: a phone has its search. */}
          <Show when={!touch()}>
            <button type="button" role="menuitem" onClick={() => { close(); o.openGoTo(); }}>
              Перейти к пункту… <span class="hint">Ctrl+K</span>
              <GO />
            </button>
          </Show>
          <Show when={!o.readOnly}>
            <button type="button" role="menuitem" onClick={() => { close(); o.openCapture(); }}>
              Записать в Inbox
              <Show when={!touch()}><span class="hint">Ctrl+Shift+Space</span></Show>
              <WRITE />
            </button>
            <div class="menu-sep" role="separator" />
          </Show>
          <button type="button" role="menuitem" onClick={() => exportAs('md')}>
            Скачать как Markdown
            <SAVE />
          </button>
          <button type="button" role="menuitem" onClick={() => exportAs('opml')}>
            Скачать как OPML <span class="hint">для Workflowy</span>
            <SAVE />
          </button>
          <button type="button" role="menuitem" onClick={() => { close(); o.showHelp(); }}>
            <Show when={touch()} fallback={<>Горячие клавиши <span class="hint">?</span></>}>Жесты и клавиши</Show>
            <KEYS />
          </button>
          {/* One name whatever the theme, its state a check (Apple's menus): not "Night" turning into "Day". */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={theme() === 'dark'}
            onClick={(e) => {
              // Measure before closing: the circle opens from this item.
              const from = e.currentTarget.getBoundingClientRect();
              close();
              toggleTheme(from);
            }}
          >
            Тёмная тема
            <Show when={theme() === 'dark'} fallback={<MOON />}>
              <CHECK />
            </Show>
          </button>
          {/* Steps keep the menu open: the outline behind shows each size at once. */}
          <div class="menu-stepper" role="group" aria-label="Размер текста">
            <span class="menu-stepper-label">Размер текста</span>
            <button
              type="button"
              class="step"
              aria-label="Мельче"
              disabled={textScale() === TEXT_SCALES[0]}
              onClick={() => stepTextScale(-1)}
            >
              {/* A small and a large A, as Apple sizes text (Safari's "Aa"). */}
              <span class="step-a small" aria-hidden="true">A</span>
            </button>
            <span class="step-value" aria-live="polite">{Math.round(textScale() * 100)}%</span>
            <button
              type="button"
              class="step"
              aria-label="Крупнее"
              disabled={textScale() === TEXT_SCALES[TEXT_SCALES.length - 1]}
              onClick={() => stepTextScale(1)}
            >
              <span class="step-a large" aria-hidden="true">A</span>
            </button>
          </div>
          <div class="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => { close(); o.showTrash(); }}>
            {o.trashOpen() ? 'Скрыть корзину' : 'Корзина'}
            <Show when={!o.trashOpen() && o.deleted().length}>
              <span class="hint">{o.deleted().length}</span>
            </Show>
            <TRASH />
          </button>
          <Show when={!o.readOnly}>
            <button type="button" role="menuitem" onClick={() => { close(); o.createStructure(); }}>
              Создать структуру <span class="hint">PARA и календарь</span>
              <CALENDAR />
            </button>
            <button type="button" role="menuitem" onClick={() => void importFile()}>
              Импорт из файла…
              <OPEN />
            </button>
          </Show>
          <Show when={o.opened && !o.readOnly}>
            <div class="menu-sep" role="separator" />
            <Show when={o.syncing()}>
              <p class="menu-note">{describeSync(o.syncStatus())}</p>
            </Show>
            <button type="button" role="menuitem" onClick={() => { close(); o.showSync(); }}>
              {o.syncing() ? 'Синхронизация…' : 'Синхронизация между устройствами…'}
              <CLOUD />
            </button>
          </Show>
          <Show when={backup()}>
            {(b) => (
              <>
                <div class="menu-sep" role="separator" />
                <Switch>
                  <Match when={b().state === 'unsupported'}>
                    <p class="menu-note">Автокопия в папку работает в Chrome и Edge</p>
                  </Match>
                  <Match when={b().state === 'off'}>
                    <button type="button" role="menuitem" onClick={act(() => o.backup?.choose())}>
                      Автокопия в папку…
                      <FOLDER />
                    </button>
                  </Match>
                  <Match when={b().state === 'on'}>
                    <p class="menu-note">
                      Автокопия: <b>{b().folder}</b>
                      <Show when={b().last}>, последняя в {time(b().last)}</Show>
                    </p>
                    <button type="button" role="menuitem" onClick={act(() => o.backup?.write())}>
                      Сохранить копию сейчас
                    </button>
                    <button type="button" role="menuitem" onClick={act(() => o.backup?.disable())}>
                      Отключить автокопию
                    </button>
                  </Match>
                  <Match when={b().state === 'paused' || b().state === 'error'}>
                    <button type="button" role="menuitem" class="attention" onClick={act(() => o.backup?.resume())}>
                      {b().state === 'paused' ? 'Автокопия на паузе — продолжить' : 'Автокопия не удалась — повторить'}
                    </button>
                    <button type="button" role="menuitem" onClick={act(() => o.backup?.disable())}>
                      Отключить автокопию
                    </button>
                  </Match>
                </Switch>
              </>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}
