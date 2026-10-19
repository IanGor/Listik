import { Show } from 'solid-js';
import { DocumentMenu } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';
import { narrow } from './screen';
import { describeSync, syncState } from './SyncDialog';
import { theme, toggleTheme } from './theme';

/**
 * The header, as in Workflowy: name, search, and the day/night switch. On a
 * phone-width screen the cloud and the switch live in the menu instead.
 */
export function TopBar(props: { o: Outliner }) {
  return (
    <header class="topbar">
      <button
        type="button"
        class="brand"
        title="На главную, всё свернуть"
        aria-label="Listik: на главную, всё свернуть"
        onClick={() => props.o.goHome()}
      >
        Listik
      </button>
      <SearchBar o={props.o} />
      <div class="topbar-actions">
        <Show when={!narrow() && props.o.syncing()}>
          <SyncIndicator o={props.o} />
        </Show>
        <DocumentMenu o={props.o} />
        <Show when={!narrow()}>
          <ThemeToggle />
        </Show>
      </div>
    </header>
  );
}

/** A cloud: plain when in step with the server, with a dot while changes wait, crossed without a connection. */
function SyncIndicator(props: { o: Outliner }) {
  const status = () => props.o.syncStatus();
  const state = () => syncState(status());
  return (
    <button
      type="button"
      class={`icon-button sync-indicator sync-${state()}`}
      title={describeSync(status())}
      aria-label={`Синхронизация: ${describeSync(status())}`}
      onClick={() => props.o.showSync()}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5 3.75 3.75 0 0 1 17.5 18H7z" />
        <Show when={state() === 'offline'}><path d="M4 4l16 16" /></Show>
        <Show when={state() === 'error'}><path d="M12 10v3M12 15.5v.5" /></Show>
      </svg>
      <Show when={state() === 'pending'}><span class="sync-dot" /></Show>
    </button>
  );
}

function ThemeToggle() {
  const dark = () => theme() === 'dark';
  const label = () => (dark() ? 'Дневная тема' : 'Ночная тема');

  return (
    <button
      type="button"
      class="icon-button theme-toggle"
      title={label()}
      aria-label={label()}
      onClick={(e) => toggleTheme(e.currentTarget.getBoundingClientRect())}
    >
      <Show when={dark()} fallback={<MoonIcon />}>
        <SunIcon />
      </Show>
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}
