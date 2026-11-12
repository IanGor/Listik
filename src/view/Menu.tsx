import { For, Match, Show, Switch, createRenderEffect, createSignal, onCleanup, type JSX } from 'solid-js';
import { appendTrees } from '../model/commands';
import { countTrees, looksLikeOpml, parseIndented, parseOpml, toMarkdown, toOpml } from '../model/outline-text';
import type { BackupStatus } from '../persist/backup';
import { plural } from '../util/plural';
import { dateStamp, download, pickFile } from './files';
import { KINDS, KIND_TITLES, availableFonts, fontStack, setFont } from './fonts';
import type { Outliner } from './outliner';
import { MOD, phone, touch } from './screen';
import { describeSync, syncState } from './SyncDialog';
import { TEXT_SCALES, stepTextScale, textScale } from './textsize';
import { THEMES, preference, openThemePanel, themePanelOpen } from './theme';
import { ThemePanel } from './ThemePanel';
import { exportUsage } from './analytics';

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

const UNDO = () => <Symbol><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Symbol>;
const REDO = () => <Symbol><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></Symbol>;
const GO = () => <Symbol><circle cx="12" cy="12" r="9" /><path d="M8 12h8M13 8.5l3.5 3.5-3.5 3.5" /></Symbol>;
// A note being written (square.and.pencil): the tray is the header's Inbox, a place, not this action.
export const WriteIcon = () => <Symbol><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" /></Symbol>;
const SAVE = () => <Symbol><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3" /></Symbol>;
const OPEN = () => <Symbol><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M12 17v-6M9 14l3-3 3 3" /></Symbol>;
const KEYS = () => <Symbol><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" /></Symbol>;
const CHECK = () => <Symbol><path d="M5 12.5l4.5 4.5L19 7.5" /></Symbol>;
const TRASH = () => <Symbol><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></Symbol>;
const CALENDAR = () => <Symbol><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Symbol>;
const CLOUD = () => <Symbol><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 0 0 4.6 12.6 3.5 3.5 0 0 0 6.5 19z" /></Symbol>;
const CHEVRON = () => <Symbol><path d="M6 9l6 6 6-6" /></Symbol>;
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
  const [fontsOpen, setFontsOpen] = createSignal(false);
  const [filesOpen, setFilesOpen] = createSignal(false);
  const [backup, setBackup] = createSignal<BackupStatus | null>(o.backup?.status ?? null);
  if (o.backup) onCleanup(o.backup.subscribe(setBackup));
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const items = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.menu button:not(:disabled)')).filter((item) => item.getClientRects().length > 0);
  const focusEdge = (last = false) => queueMicrotask(() => { const list = items(); (last ? list.at(-1) : list[0])?.focus(); });

  const close = () => {
    setOpen(false);
    setFontsOpen(false);
    setFilesOpen(false);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || !open() || !root.contains(e.target as Node)) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); close(); trigger.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const list = items(); const index = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'Tab') {
      // Resolve the next outside stop before unmounting the focused menu item.
      const stops = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"], a[href]')).filter((el) => el.getClientRects().length && !el.closest('.menu'));
      const index = stops.indexOf(trigger);
      const next = e.shiftKey ? trigger : stops[index + 1];
      if (next) { e.preventDefault(); close(); next.focus(); }
      else close();
    }
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
      <Show when={themePanelOpen()}><ThemePanel /></Show>
      <button ref={trigger} data-action="Menu.1"
        type="button"
        class="icon-button menu-button"
        title={o.syncing() ? `Документ. ${describeSync(o.syncStatus())}` : 'Документ: экспорт, импорт, тема, синхронизация'}
        aria-label="Меню документа"
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={(e) => { const show = !open(); setOpen(show); if (show && e.detail === 0) focusEdge(); }}
        onKeyDown={(e) => { if (!open() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); setOpen(true); focusEdge(e.key === 'ArrowUp'); } }}
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
          {/* Grouped by what for (UX audit, 29 October 2026): going and writing; undo; the look; the document; files; help. */}
          <button type="button" data-action="document.search" role="menuitem" onClick={() => { close(); o.requestSearch(); }}>Поиск</button>
          {/* Going to a place by its name: on a phone too, the line at the top of the screen as for "Куда…". */}
          <button data-action="Menu.2" type="button" role="menuitem" onClick={() => { close(); o.openGoTo(); }}>
            Перейти к пункту… <Show when={!phone()}><span class="hint">{MOD}+K</span></Show>
            <GO />
          </button>
          <Show when={!o.readOnly}>
            <button data-action="Menu.3" type="button" role="menuitem" onClick={() => { close(); o.openCapture(); }}>
              Записать в Inbox
              <Show when={!phone()}><span class="hint">{MOD}+Shift+Space</span></Show>
              <WriteIcon />
            </button>
          </Show>
          <button data-action="Menu.4" type="button" role="menuitem" onClick={() => { close(); o.showTrash(); }}>
            {o.trashOpen() ? 'Скрыть корзину' : 'Корзина'}
            <Show when={!o.trashOpen() && o.deleted().length}>
              <span class="hint">{o.deleted().length}</span>
            </Show>
            <TRASH />
          </button>
          <div class="menu-sep" role="separator" />
          {/* Undo for a mouse, and for a phone out of editing (its bar has undo only while a bullet is edited). */}
          <Show when={!o.readOnly && (o.history.canUndo || o.history.canRedo)}>
            <Show when={o.history.canUndo}>
              <button data-action="Menu.5" type="button" role="menuitem" onClick={() => { close(); o.undo(); }}>
                Отменить <Show when={!phone()}><span class="hint">{MOD}+Z</span></Show>
                <UNDO />
              </button>
            </Show>
            <Show when={o.history.canRedo}>
              <button data-action="Menu.6" type="button" role="menuitem" onClick={() => { close(); o.redo(); }}>
                Повторить <Show when={!phone()}><span class="hint">{MOD}+Shift+Z</span></Show>
                <REDO />
              </button>
            </Show>
            <div class="menu-sep" role="separator" />
          </Show>
          <button data-action="Menu.7" type="button" role="menuitem" aria-haspopup="dialog" onClick={() => { close(); openThemePanel(); }}>
            Тема <span class="hint">{THEMES.find(t => t.id === preference().themeId)?.name}</span><CHEVRON />
          </button>
          {/* Steps keep the menu open: the outline behind shows each size at once. */}
          <div class="menu-stepper" role="group" aria-label="Размер текста">
            <span class="menu-stepper-label">Размер текста</span>
            <button data-action="Menu.8"
              type="button"
              class="step"
              aria-label="Мельче"
              disabled={textScale() === TEXT_SCALES[0]}
              onClick={() => stepTextScale(-1)}
            >
              {/* A small and a large A, as Apple sizes text (Safari's "Aa"). */}
              <span class="step-a small" aria-hidden="true">A</span>
            </button>
            {/* Update the element itself: native DOM changes must not strand a cached text node. */}
            <span class="step-value" aria-live="polite" aria-atomic="true" ref={(el) => createRenderEffect(() => {
              el.textContent = `${Math.round(textScale() * 100)}%`;
            })} />
            <button data-action="Menu.9"
              type="button"
              class="step"
              aria-label="Крупнее"
              disabled={textScale() === TEXT_SCALES[TEXT_SCALES.length - 1]}
              onClick={() => stepTextScale(1)}
            >
              <span class="step-a large" aria-hidden="true">A</span>
            </button>
          </div>
          {/* The font: the list is probed when first opened, and picks keep the menu open like the size's steps. */}
          <button data-action="Menu.10" type="button" role="menuitem" aria-expanded={fontsOpen()} onClick={() => setFontsOpen(!fontsOpen())}>
            Шрифт
            <span class="hint">{Object.values(availableFonts()).flat().find((f) => f.stack === fontStack())?.name}</span>
            <CHEVRON />
          </button>
          <Show when={fontsOpen()}>
            <div class="menu-fonts" role="group" aria-label="Шрифт">
              <For each={KINDS}>
                {(kind) => (
                  <Show when={availableFonts()[kind].length}>
                    <div class="menu-fonts-title">{KIND_TITLES[kind]}</div>
                    <For each={availableFonts()[kind]}>
                      {(f) => (
                        <button data-action="Menu.11"
                          type="button"
                          role="menuitemradio"
                          aria-checked={fontStack() === f.stack}
                          style={{ 'font-family': f.stack }}
                          onClick={() => setFont(f.stack)}
                        >
                          {f.name}
                          <Show when={fontStack() === f.stack}><CHECK /></Show>
                        </button>
                      )}
                    </For>
                  </Show>
                )}
              </For>
            </div>
          </Show>
          <div class="menu-sep" role="separator" />
          <Show when={o.opened && !o.readOnly}>
            <Show when={o.syncing()}>
              <p class="menu-note">{describeSync(o.syncStatus())}</p>
            </Show>
            <button data-action="Menu.12" type="button" role="menuitem" onClick={() => { close(); o.showSync(); }}>
              Синхронизация…
              <CLOUD />
            </button>
          </Show>
          <Show when={!o.readOnly}>
            <button data-action="Menu.13" type="button" role="menuitem" onClick={() => { close(); o.createStructure(); }}>
              Создать структуру <span class="hint">PARA и календарь</span>
              <CALENDAR />
            </button>
          </Show>
          <div class="menu-sep" role="separator" />
          <button data-action="Menu.14" type="button" role="menuitem" aria-expanded={filesOpen()} onClick={() => setFilesOpen(!filesOpen())}>
            Файлы и резервные копии
            <Show when={backup()?.state === 'paused' || backup()?.state === 'error'}>
              <span class="hint attention">Автокопия требует внимания</span>
            </Show>
            <CHEVRON />
          </button>
          <Show when={filesOpen()}>
            <div class="menu-files" role="group" aria-label="Файлы и резервные копии">
              <button data-action="analytics.export" type="button" role="menuitem" onClick={() => { close(); void exportUsage().catch(() => o.notify('Не удалось выгрузить аналитику')); }}>
                Скачать аналитику использования
                <SAVE />
              </button>
              <button data-action="Menu.15" type="button" role="menuitem" onClick={() => exportAs('md')}>
                Скачать как Markdown
                <SAVE />
              </button>
              <button data-action="Menu.16" type="button" role="menuitem" onClick={() => exportAs('opml')}>
                Скачать как OPML <span class="hint">для Workflowy</span>
                <SAVE />
              </button>
              <Show when={!o.readOnly}>
                <button data-action="Menu.17" type="button" role="menuitem" onClick={() => void importFile()}>
                  Импорт из файла…
                  <OPEN />
                </button>
              </Show>
              <Show when={backup()}>
                {(b) => (
                  <>
                    <Switch>
                      <Match when={b().state === 'unsupported'}>
                        <p class="menu-note">Этот браузер не поддерживает автозапись в папку. Можно скачать копию документа.</p>
                        <button type="button" data-action="backup.download" role="menuitem" onClick={() => exportAs('md')}>Скачать копию сейчас</button>
                      </Match>
                      <Match when={b().state === 'off'}>
                        <button data-action="Menu.18" type="button" role="menuitem" onClick={act(() => o.backup?.choose())}>
                          Автокопия в папку…
                          <FOLDER />
                        </button>
                      </Match>
                      <Match when={b().state === 'on'}>
                        <p class="menu-note">
                          Автокопия: <b>{b().folder}</b>
                          <Show when={b().last}>, последняя в {time(b().last)}</Show>
                        </p>
                        <button data-action="Menu.19" type="button" role="menuitem" onClick={act(() => o.backup?.write())}>
                          Сохранить копию сейчас
                        </button>
                        <button data-action="Menu.20" type="button" role="menuitem" onClick={act(() => o.backup?.disable())}>
                          Отключить автокопию
                        </button>
                      </Match>
                      <Match when={b().state === 'paused' || b().state === 'error'}>
                        <button data-action="Menu.21" type="button" role="menuitem" class="attention" onClick={act(() => o.backup?.resume())}>
                          {b().state === 'paused' ? 'Автокопия на паузе — продолжить' : 'Автокопия не удалась — повторить'}
                        </button>
                        <button data-action="Menu.22" type="button" role="menuitem" onClick={act(() => o.backup?.disable())}>
                          Отключить автокопию
                        </button>
                      </Match>
                    </Switch>
                  </>
                )}
              </Show>
            </div>
          </Show>
          <div class="menu-sep" role="separator" />
          <button data-action="Menu.23" type="button" role="menuitem" onClick={() => { close(); o.showHelp(); }}>
            <Show when={touch()} fallback={<>Горячие клавиши <span class="hint">?</span></>}>Жесты и клавиши</Show>
            <KEYS />
          </button>
        </div>
      </Show>
    </div>
  );
}
