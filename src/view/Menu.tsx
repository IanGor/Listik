import { Match, Show, Switch, createSignal, onCleanup } from 'solid-js';
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
          <button type="button" role="menuitem" onClick={() => exportAs('md')}>
            Скачать как Markdown
          </button>
          <button type="button" role="menuitem" onClick={() => exportAs('opml')}>
            Скачать как OPML <span class="hint">для Workflowy</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { close(); o.showHelp(); }}>
            <Show when={touch()} fallback={<>Горячие клавиши <span class="hint">?</span></>}>Жесты и клавиши</Show>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              // Measure before closing: the circle opens from this item.
              const from = e.currentTarget.getBoundingClientRect();
              close();
              toggleTheme(from);
            }}
          >
            {theme() === 'dark' ? 'Дневная тема' : 'Ночная тема'}
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
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <path d="M3 7h8" />
              </svg>
            </button>
            <span class="step-value" aria-live="polite">{Math.round(textScale() * 100)}%</span>
            <button
              type="button"
              class="step"
              aria-label="Крупнее"
              disabled={textScale() === TEXT_SCALES[TEXT_SCALES.length - 1]}
              onClick={() => stepTextScale(1)}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <path d="M3 7h8M7 3v8" />
              </svg>
            </button>
          </div>
          <div class="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={() => { close(); o.showTrash(); }}>
            {o.trashOpen() ? 'Скрыть корзину' : 'Корзина'}
            <Show when={!o.trashOpen() && o.deleted().length}>
              <span class="hint">{o.deleted().length}</span>
            </Show>
          </button>
          <Show when={!o.readOnly}>
            <button type="button" role="menuitem" onClick={() => { close(); o.createStructure(); }}>
              Создать структуру <span class="hint">PARA и календарь</span>
            </button>
            <button type="button" role="menuitem" onClick={() => void importFile()}>
              Импорт из файла…
            </button>
          </Show>
          <Show when={o.opened && !o.readOnly}>
            <div class="menu-sep" role="separator" />
            <Show when={o.syncing()}>
              <p class="menu-note">{describeSync(o.syncStatus())}</p>
            </Show>
            <button type="button" role="menuitem" onClick={() => { close(); o.showSync(); }}>
              {o.syncing() ? 'Синхронизация…' : 'Синхронизация между устройствами…'}
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
