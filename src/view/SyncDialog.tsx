import { Match, Show, Switch, createEffect, createSignal, on } from 'solid-js';
import { normalizeServer } from '../sync/client';
import type { SyncStatus } from '../sync/engine';
import { changePassphrase, createSync, disconnectSync, forgetOnDevice, joinSync, relogin, requestRestore } from '../sync/setup';
import { plural } from '../util/plural';
import type { Outliner } from './outliner';

const time = (t?: number) => (t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');

/** One line for the menu and the dialog. */
export function describeSync(s: SyncStatus): string {
  switch (s.phase) {
    case 'syncing': return 'Синхронизация…';
    case 'synced': return s.pending ? `Отправляется: ${s.pending} ${plural(s.pending, 'изменение', 'изменения', 'изменений')}` : `Синхронизировано${s.last ? ` в ${time(s.last)}` : ''}`;
    case 'offline': return `Нет связи${s.pending ? `, ${s.pending} ${plural(s.pending, 'изменение ждёт', 'изменения ждут', 'изменений ждут')}` : ''}`;
    case 'error': return `Ошибка: ${s.error ?? 'неизвестная'}`;
    case 'stopped': return 'Остановлено';
    default: return 'Ожидание';
  }
}

/** The cloud's state: in step with the server, changes waiting, no connection, or an error. */
export function syncState(s: SyncStatus): 'synced' | 'pending' | 'offline' | 'error' {
  if (s.phase === 'error') return 'error';
  if (s.phase === 'offline') return 'offline';
  if (s.phase === 'syncing' || s.pending) return 'pending';
  return 'synced';
}

/**
 * Sync settings: connect this document to a server (as a new document or as
 * another device of an existing one), and manage a live connection.
 */
export function SyncDialog(props: { o: Outliner }) {
  const o = props.o;
  let dialog!: HTMLDialogElement;
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [server, setServer] = createSignal(o.syncHandle?.config.server ?? '');
  const [code, setCode] = createSignal('');
  const [pass, setPass] = createSignal('');
  const [pass2, setPass2] = createSignal('');
  const [mode, setMode] = createSignal<'create' | 'join' | 'change'>('create');
  const [copied, setCopied] = createSignal(false);
  /** The live session, reactive through the status. */
  const handle = () => (o.syncing() ? o.syncHandle : null);

  createEffect(on(o.syncRequests, () => {
    setError(null);
    setPass('');
    setPass2('');
    setMode(o.syncHandle ? 'change' : 'create');
    if (!dialog.open) dialog.showModal();
  }, { defer: true }));

  const attempt = (fn: () => Promise<void>) => async (e: Event) => {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const validServer = () => /^https?:\/\/\S+$/.test(normalizeServer(server()));
  const passOk = () => pass().length >= 8 && pass() === pass2();

  const create = attempt(async () => {
    if (!o.persistence || !o.opened) throw new Error('Документ только в памяти');
    if (!passOk()) throw new Error('Пароли не совпадают или короче 8 знаков');
    // The document starts on the server with the structure (model/calendar.ts).
    o.firstStructure(false);
    o.syncHandle = await createSync(o.doc, o.opened, o.persistence, server(), pass());
    o.watchSync();
    dialog.close();
    o.notify('Синхронизация включена. Код документа — в меню «Синхронизация», он нужен другим устройствам');
  });

  const join = attempt(async () => {
    if (!o.opened) throw new Error('Документ только в памяти');
    if (!pass()) throw new Error('Введите пароль');
    await joinSync(o.opened, o.persistence, server(), code().trim(), pass());
    location.reload();
  });

  const change = attempt(async () => {
    if (!o.syncHandle || !o.opened) return;
    if (!passOk()) throw new Error('Пароли не совпадают или короче 8 знаков');
    await changePassphrase(o.syncHandle, o.opened, pass());
    location.reload();
  });

  const signIn = attempt(async () => {
    if (!o.syncHandle || !o.opened) return;
    if (!pass()) throw new Error('Введите пароль');
    await relogin(o.syncHandle, o.opened, pass());
    location.reload();
  });

  const forget = attempt(async () => {
    if (!o.opened) return;
    await forgetOnDevice(o.opened);
    dialog.close();
    o.notify('При следующем открытии здесь спросят пароль');
  });

  const restore = attempt(async () => {
    if (!o.syncHandle || !o.persistence || !o.opened) return;
    if (!confirm('Заменить документ в этом браузере копией с сервера? Правки, ещё не отправленные туда, сохранятся.')) return;
    await requestRestore(o.syncHandle, o.persistence, o.opened);
    location.reload();
  });

  const disconnect = attempt(async () => {
    if (!o.syncHandle || !o.persistence || !o.opened) return;
    if (!confirm('Отключить синхронизацию в этом браузере? Документ останется здесь и на сервере, но перестанет обновляться.')) return;
    await disconnectSync(o.syncHandle, o.persistence, o.opened);
    o.syncHandle = null;
    o.watchSync();
    dialog.close();
    o.notify('Синхронизация отключена');
  });

  const copyCode = async () => {
    const id = o.syncHandle?.config.docId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard: the code is visible, it can be selected.
    }
  };

  return (
    <dialog ref={dialog} class="sheet sync-dialog" aria-label="Синхронизация" onClick={(e) => e.target === dialog && dialog.close()}>
      <div class="sheet-body">
        <div class="sheet-head">
          <h2>Синхронизация</h2>
          <button type="button" class="icon-button" aria-label="Закрыть" onClick={() => dialog.close()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <Switch>
          <Match when={handle()}>
            {(h) => (
              <>
                <dl class="sync-facts">
                  <dt>Сервер</dt><dd>{h().config.server}</dd>
                  <dt>Код документа</dt>
                  <dd>
                    <code class="doc-code">{h().config.docId}</code>
                    <button type="button" class="button small" onClick={() => void copyCode()}>{copied() ? 'Скопировано' : 'Копировать'}</button>
                  </dd>
                  <dt>Состояние</dt><dd>{describeSync(o.syncStatus())}</dd>
                </dl>
                <Show when={o.syncStatus().refused}>
                  <form class="form sync-relogin" onSubmit={(e) => void signIn(e)}>
                    <p class="form-note">Пароль сменили на другом устройстве. Введите новый: правки, ещё не отправленные с этого, сохранятся.</p>
                    <label class="field"><span>Новый пароль</span><input type="password" autocomplete="current-password" value={pass()} onInput={(e) => setPass(e.currentTarget.value)} /></label>
                    <button type="submit" class="button primary" disabled={busy() || !pass()}>{busy() ? 'Проверяю…' : 'Продолжить'}</button>
                  </form>
                </Show>
                <p class="form-note">
                  На другом устройстве откройте Listik, выберите «Синхронизация → Подключиться» и введите адрес сервера, код документа и пароль.
                </p>
                <div class="button-row">
                  <button type="button" class="button" disabled={busy()} onClick={() => void h().engine.sync().catch(() => {})}>Синхронизировать сейчас</button>
                  <button type="button" class="button" onClick={() => setMode(mode() === 'change' ? 'create' : 'change')}>Сменить пароль</button>
                  <button type="button" class="button" disabled={busy()} onClick={(e) => void forget(e)}>Забыть пароль здесь</button>
                  <button type="button" class="button" disabled={busy()} onClick={(e) => void restore(e)}>Загрузить с сервера</button>
                  <button type="button" class="button danger" disabled={busy()} onClick={(e) => void disconnect(e)}>Отключить</button>
                </div>
                <Show when={mode() === 'change' && !o.syncStatus().refused}>
                  <form class="form" onSubmit={(e) => void change(e)}>
                    <label class="field"><span>Новый пароль</span><input type="password" autocomplete="new-password" value={pass()} onInput={(e) => setPass(e.currentTarget.value)} /></label>
                    <label class="field"><span>Ещё раз</span><input type="password" autocomplete="new-password" value={pass2()} onInput={(e) => setPass2(e.currentTarget.value)} /></label>
                    <p class="form-note">Другие устройства попросят новый пароль при следующем открытии.</p>
                    <button type="submit" class="button primary" disabled={busy() || !passOk()}>{busy() ? 'Меняю…' : 'Сменить пароль'}</button>
                  </form>
                </Show>
              </>
            )}
          </Match>
          <Match when={!handle()}>
            <div class="tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode() === 'create'} onClick={() => setMode('create')}>Новый документ на сервере</button>
              <button type="button" role="tab" aria-selected={mode() === 'join'} onClick={() => setMode('join')}>Подключиться к существующему</button>
            </div>
            <form class="form" onSubmit={(e) => void (mode() === 'create' ? create(e) : join(e))}>
              <label class="field">
                <span>Сервер</span>
                <input type="url" placeholder="https://sync.example.com" value={server()} onInput={(e) => setServer(e.currentTarget.value)} />
              </label>
              <Show when={mode() === 'join'}>
                <label class="field">
                  <span>Код документа</span>
                  <input type="text" autocomplete="off" spellcheck={false} value={code()} onInput={(e) => setCode(e.currentTarget.value)} />
                </label>
              </Show>
              <label class="field">
                <span>Пароль</span>
                <input type="password" autocomplete={mode() === 'create' ? 'new-password' : 'current-password'} value={pass()} onInput={(e) => setPass(e.currentTarget.value)} />
              </label>
              <Show when={mode() === 'create'}>
                <label class="field">
                  <span>Ещё раз</span>
                  <input type="password" autocomplete="new-password" value={pass2()} onInput={(e) => setPass2(e.currentTarget.value)} />
                </label>
                <p class="form-note">
                  Этот документ будет зашифрован паролем и отправлен на сервер. Сервер видит только шифротекст; пароль и ключ его не покидают.
                  Забытый пароль восстановить нельзя.
                </p>
              </Show>
              <Show when={mode() === 'join'}>
                <p class="form-note">
                  Документ в этом браузере будет <b>заменён</b> документом с сервера. Если здесь есть что‑то нужное, сначала скачайте его через меню.
                </p>
              </Show>
              <Show when={error()}>{(m) => <p class="form-error" role="alert">{m()}</p>}</Show>
              <button type="submit" class="button primary" disabled={busy() || !validServer() || (mode() === 'create' ? !passOk() : !code() || !pass())}>
                {busy() ? 'Подождите…' : mode() === 'create' ? 'Создать и включить' : 'Подключиться'}
              </button>
            </form>
          </Match>
        </Switch>
        <Show when={error() && handle()}>{(m) => <p class="form-error" role="alert">{String(m())}</p>}</Show>
      </div>
    </dialog>
  );
}
