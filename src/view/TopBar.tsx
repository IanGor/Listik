import { DocumentMenu } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';

/**
 * The header, as in Workflowy: name (it leads to today, in the forever
 * calendar), search and the menu. The day/night
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
        <DocumentMenu o={props.o} />
      </div>
    </header>
  );
}
