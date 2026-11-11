import { Show, createSignal, onCleanup } from 'solid-js';
import { WriteIcon } from './Menu';
import type { Outliner } from './outliner';

/** Existing sidebar symbol, shared by every navigation entry point. */
export function NavigationIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4" /><path d="M9 4v16M5.8 8h.4M5.8 12h.4" stroke-linecap="round" /></svg>;
}

export function Places(props: { o: Outliner; onNavigate?: () => void; homeFirst?: boolean }) {
  // Today's number on the calendar symbol: past midnight it turns over by itself.
  const [day, setDay] = createSignal(new Date().getDate());
  const tick = setInterval(() => setDay(new Date().getDate()), 60_000);
  onCleanup(() => clearInterval(tick));
  const Today = () => (<button data-action="TopBar.1"
          type="button"
          class="place today-button"
          title="Сегодняшний день в календаре"
          aria-label="Сегодня"
          aria-current={props.o.placeNow() === 'today' ? 'page' : undefined}
          onClick={() => { props.o.goToday(); props.onNavigate?.(); }}
        >
          <svg class="place-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="4.5" width="17" height="16" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M3.5 9h17" stroke="currentColor" stroke-width="1.6" />
            <path d="M8 2.75v3.5M16 2.75v3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            <text x="12" y="18.4" text-anchor="middle" font-size={day() > 9 ? "9.5" : "10.5"} font-weight="700" letter-spacing="-0.3" fill="currentColor">{day()}</text>
          </svg>
          <span class="place-label">Сегодня</span>
        </button>);
  const Home = () => (<button data-action="TopBar.2"
          type="button"
          class="place home-button"
          title="На главную"
          aria-label="Главная"
          aria-current={props.o.zoom() === null ? 'page' : undefined}
          onClick={() => { props.o.goHome(); props.onNavigate?.(); }}
        >
          <svg class="place-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
            <path d="M9 21v-8h6v8" />
          </svg>
          <span class="place-label">Главная</span>
        </button>);
  return <nav class="places" aria-label="Места">
    <Show when={props.homeFirst} fallback={<><Today /><Home /></>}><Home /><Today /></Show>
  </nav>;
}

export function CaptureButton(props: { o: Outliner; labelled?: boolean }) {
  return (
        <Show when={!props.o.readOnly}>
          <button data-action="TopBar.3" type="button" class="icon-button" title="Записать в Inbox" aria-label="Записать в Inbox" onPointerDown={(e) => e.preventDefault()} onClick={() => props.o.openCapture()}>
            <WriteIcon />
            <Show when={props.labelled}><span class="place-label">Записать в Inbox</span></Show>
          </button>
        </Show>
  );
}
