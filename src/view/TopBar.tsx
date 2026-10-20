import { DocumentMenu } from './Menu';
import type { Outliner } from './outliner';
import { SearchBar } from './SearchBar';

/**
 * The header, as in Workflowy: the tree panel's switch, name (it leads to
 * today, in the structure's calendar), search and the menu. The day/night
 * switch and the sync state live in the menu, on every screen.
 */
export function TopBar(props: { o: Outliner }) {
  return (
    <header class="topbar">
      <div class="topbar-start">
        {/* The tree panel's switch: one press, where sidebars are switched (Notion, VS Code, Gmail). */}
        <button
          type="button"
          class="tree-toggle"
          classList={{ on: props.o.treeOpen() }}
          title={props.o.treeOpen() ? 'Скрыть дерево (Ctrl+\\)' : 'Дерево документа (Ctrl+\\)'}
          aria-label="Дерево документа"
          aria-pressed={props.o.treeOpen()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.o.showTree()}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
            <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2.5" />
            <path d="M7.75 3.75v12.5" />
            <path class="tree-toggle-fill" d="M3.5 5.5h3.5v9h-3.5z" stroke="none" />
          </svg>
        </button>
        <button
          type="button"
          class="brand"
          title="Сегодня"
          aria-label="Listik: сегодня"
          onClick={() => props.o.goToday()}
        >
          Listik
        </button>
      </div>
      <SearchBar o={props.o} />
      <div class="topbar-actions">
        <DocumentMenu o={props.o} />
      </div>
    </header>
  );
}
