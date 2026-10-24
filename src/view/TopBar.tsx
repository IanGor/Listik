import { createSignal, onCleanup, Show } from 'solid-js';
import { DocumentMenu } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';
import { watchWindowControls } from './window-controls';

/**
 * The header: the two places a day starts from — today's day and the
 * Inbox — then search and the menu. The places are named, not a logo to
 * guess at, and stand together at the leading edge, the one you are in lit
 * (`aria-current`), as Apple's guides ask of navigation. On a phone they are
 * their symbols alone. Quick capture lives on Ctrl+Shift+Space and in the
 * menu; the day/night switch and the sync state too, on every screen.
 */
export function TopBar(props: { o: Outliner }) {
  // In an iPadOS window the controls lie over the header's left corner: the places step aside.
  onCleanup(watchWindowControls());
  // Today's number on the calendar symbol: past midnight it turns over by itself.
  const [day, setDay] = createSignal(new Date().getDate());
  const tick = setInterval(() => setDay(new Date().getDate()), 60_000);
  onCleanup(() => clearInterval(tick));
  const count = () => props.o.inboxCount();
  return (
    <header class="topbar">
      <nav class="places" aria-label="Места">
        <button
          type="button"
          class="place today-button"
          title="Сегодняшний день в календаре"
          aria-label="Сегодня"
          aria-current={props.o.placeNow() === 'today' ? 'page' : undefined}
          onClick={() => props.o.goToday()}
        >
          <svg class="place-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="4.5" width="17" height="16" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M3.5 9h17" stroke="currentColor" stroke-width="1.6" />
            <path d="M8 2.75v3.5M16 2.75v3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <text x="12" y="18.4" text-anchor="middle" font-size={day() > 9 ? "9.5" : "10.5"} font-weight="700" letter-spacing="-0.3" fill="currentColor">{day()}</text>
          </svg>
          <span class="place-label">Сегодня</span>
        </button>
        <button
          type="button"
          class="place inbox-button"
          title={count() ? `Inbox: ${count()} в ожидании` : 'Inbox'}
          aria-label={count() ? `Inbox, ${count()}` : 'Inbox'}
          aria-current={props.o.placeNow() === 'inbox' ? 'page' : undefined}
          onClick={() => props.o.goInbox()}
        >
          <svg class="place-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 12h-6l-2 3h-4l-2-3H2" />
            <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
          <span class="place-label">Inbox</span>
          <Show when={count()}>{(n) => <span class="place-count" aria-hidden="true">{n()}</span>}</Show>
        </button>
      </nav>
      <SearchBar o={props.o} />
      <div class="topbar-actions">
        <DocumentMenu o={props.o} />
      </div>
    </header>
  );
}
