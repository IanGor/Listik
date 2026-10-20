import { Show } from 'solid-js';
import { DocumentMenu } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';

/**
 * The header, as in Workflowy: name (it leads to today, in the
 * structure's calendar), search, quick capture to the Inbox and the menu. The day/night
 * switch and the sync state live in the menu, on every screen.
 */
export function TopBar(props: { o: Outliner }) {
  return (
    <header class="topbar">
      <button
        type="button"
        class="brand"
        title="Сегодня"
        aria-label="Listik: сегодня"
        onClick={() => props.o.goToday()}
      >
        Listik
      </button>
      <SearchBar o={props.o} />
      <div class="topbar-actions">
        {/* Quick capture: a tray, not a "+": "+" adds here, this sends to the Inbox from anywhere. Computer only; on a touch screen it is in the menu. */}
        <Show when={!props.o.readOnly}>
          <button
            type="button"
            class="icon-button capture-button"
            title="Записать в Inbox (Ctrl+Shift+Space)"
            aria-label="Записать в Inbox"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.o.openCapture()}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 12h-6l-2 3h-4l-2-3H2" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
          </button>
        </Show>
        <DocumentMenu o={props.o} />
      </div>
    </header>
  );
}
