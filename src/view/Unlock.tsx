import { Show, createSignal } from 'solid-js';
import type { Opened } from '../sync/setup';
import { unlock } from '../sync/setup';

/** The passphrase screen of an encrypted document whose key this device does not remember. */
export function Unlock(props: { opened: Opened; onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = createSignal('');
  const [remember, setRemember] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy() || !passphrase()) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(props.opened, passphrase(), remember());
      props.onUnlocked();
    } catch {
      setError('Пароль не подходит');
      setBusy(false);
    }
  };

  return (
    <main class="unlock">
      <form class="form" onSubmit={(e) => void submit(e)}>
        <h1>Listik</h1>
        <p class="form-note">
          Документ зашифрован. Введите пароль синхронизации — тот же, что на других устройствах.
          Код документа: <code>{props.opened.config?.docId}</code>
        </p>
        <label class="field">
          <span>Пароль</span>
          <input
            type="password"
            autocomplete="current-password"
            autofocus
            value={passphrase()}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
          />
        </label>
        <label class="check">
          <input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
          Запомнить на этом устройстве
        </label>
        <Show when={error()}>{(m) => <p class="form-error" role="alert">{m()}</p>}</Show>
        <button type="submit" class="button primary" disabled={busy() || !passphrase()}>
          {busy() ? 'Открываю…' : 'Открыть'}
        </button>
      </form>
    </main>
  );
}
