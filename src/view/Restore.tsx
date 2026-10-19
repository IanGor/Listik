import { Show, createSignal } from 'solid-js';
import type { Opened } from '../sync/setup';
import { restoreFromServer } from '../sync/setup';

/**
 * Shown when this device remembers the document's key but its local copy
 * does not open with it (records left under an older key). The server has
 * the document: a click rebuilds the local copy from there.
 */
export function Restore(props: { opened: Opened }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await restoreFromServer(props.opened);
      location.reload();
    } catch (e) {
      setError(`Не получилось: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <main class="unlock">
      <div class="form">
        <h1>Listik</h1>
        <p class="form-note">
          Копия документа в этом браузере не открывается: часть записей зашифрована прежним ключом,
          которого здесь больше нет. На сервере документ цел, правки, ещё не отправленные туда, тоже сохранятся.
        </p>
        <p class="form-note">
          Сервер: <code>{props.opened.config?.server}</code>, код документа: <code>{props.opened.config?.docId}</code>
        </p>
        <Show when={error()}>{(m) => <p class="form-error" role="alert">{m()}</p>}</Show>
        <button type="button" class="button primary" disabled={busy()} onClick={() => void restore()}>
          {busy() ? 'Загружаю…' : 'Загрузить с сервера'}
        </button>
      </div>
    </main>
  );
}
