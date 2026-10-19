import { Show } from 'solid-js';
import { DocumentMenu } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';
import { describeSync } from './SyncDialog';
import { setTheme, theme } from './theme';

/** The header, as in Workflowy: name, search, and the day/night switch. */
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
        <Show when={props.o.syncing()}>
          <SyncIndicator o={props.o} />
        </Show>
        <DocumentMenu o={props.o} />
        <ThemeToggle />
      </div>
    </header>
  );
}

/** A cloud: plain when in step with the server, with a dot while changes wait, crossed without a connection. */
function SyncIndicator(props: { o: Outliner }) {
  const status = () => props.o.syncStatus();
  const state = () => {
    const s = status();
    if (s.phase === 'error') return 'error';
    if (s.phase === 'offline') return 'offline';
    if (s.phase === 'syncing' || s.pending) return 'pending';
    return 'synced';
  };
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

  /** The new theme opens as a circle from the button; instant with reduced motion. */
  const toggle = (e: MouseEvent) => {
    const next = dark() ? 'light' : 'dark';
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return setTheme(next);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const transition = document.startViewTransition(() => setTheme(next));
    void transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 560, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    });
  };

  return (
    <button
      type="button"
      class="icon-button theme-toggle"
      title={label()}
      aria-label={label()}
      onClick={toggle}
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
