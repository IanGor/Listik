import { Show, createSignal, onCleanup } from 'solid-js';
import { DocumentMenu, WriteIcon } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';
import { watchWindowControls } from './window-controls';

/**
 * The header: the two places a day starts from — today's day and the
 * home page — then search and the menu. The places are named, not a logo to
 * guess at, and stand together at the leading edge, the one you are in lit
 * (`aria-current`), as Apple's guides ask of navigation. On a phone they are
 * their symbols alone. Quick capture has its own button on every screen.
 */
export function TopBar(props: { o: Outliner }) {
  // In an iPadOS window the controls lie over the header's left corner: the places step aside.
  onCleanup(watchWindowControls());
  // Today's number on the calendar symbol: past midnight it turns over by itself.
  const [day, setDay] = createSignal(new Date().getDate());
  const tick = setInterval(() => setDay(new Date().getDate()), 60_000);
  onCleanup(() => clearInterval(tick));
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
          class="place home-button"
          title="На главную"
          aria-label="Главная"
          aria-current={props.o.zoom() === null ? 'page' : undefined}
          onClick={() => props.o.goHome()}
        >
          <svg class="place-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
            <path d="M9 21v-8h6v8" />
          </svg>
          <span class="place-label">Главная</span>
        </button>
      </nav>
      <SearchBar o={props.o} />
      <div class="topbar-actions">
        <Show when={!props.o.readOnly}>
          <button type="button" class="icon-button" title="Записать в Inbox" aria-label="Записать в Inbox" onPointerDown={(e) => e.preventDefault()} onClick={() => props.o.openCapture()}>
            <WriteIcon />
          </button>
        </Show>
        <DocumentMenu o={props.o} />
      </div>
    </header>
  );
}
