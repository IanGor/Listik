import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import {
  addDays, addYear, createStructure, dayOf, fillDay, findInbox, findPeriod, hasStructure, openPeriods, periodAt, periodName, quarterPeriod, sameDate, todoOf, yearTags, type DayDate, type Period,
} from '../model/calendar';
import { appendTrees, collapseAll, collapseChildren, cycleTask, deleteNode, mergeUp, moveManyInto, relink, setCollapsed, setDone, setNote, setText, sinkDone, toggleDone, untask, type Ctx, makeMirror } from '../model/commands';
import { invert, type Doc } from '../model/doc';
import { LINK_RE, plainText, toggleFormat } from '../model/format';
import { History, focusAfter, type HistoryEntry } from '../model/history';
import { linkEnd, resolveLink, titleOf } from '../model/links';
import { VisibleRows, contextOf, keepSet, nodeOf, type RowKey } from '../model/rows';
import { TextIndex, findMatches, isEmptyQuery, normalize, parseQuery, type Query } from '../model/search';
import { PendingTasks } from '../model/tasks';
import { TagIndex, searchable, tagText } from '../model/tags';
import { insertTemplate } from '../model/templates';
import { deletedEntries, restoreDeleted, type Deleted } from '../model/trash';
import type { Focus, NodeId, Op } from '../model/types';
import type { Backup } from '../persist/backup';
import type { Persistence } from '../persist/idb';
import type { SyncStatus } from '../sync/engine';
import { plural } from '../util/plural';
import type { Opened, SyncHandle } from '../sync/setup';
import { selectionIn } from './caret';
import { NodeSignals } from './node-signals';
import { narrow } from './screen';

/** A task checked off stays struck through where it is this long, then goes last among its siblings, ms. */
export const SINK_DELAY = 3000;

/**
 * Tasks just checked off (`Outliner.changeTasks`): the ops that checked them,
 * the bullets to go last and where each stood then, and, once they went, the
 * ops that moved them.
 */
interface Sinking {
  ops: Op[];
  ids: NodeId[];
  at: Map<NodeId, { parent: NodeId | null; order: string }>;
  moved: Op[];
}

/** While a bullet is being edited at midnight, the new day waits this long and is tried again, ms. */
const MIDNIGHT_RETRY = 60_000;

/** Till a moment past the next midnight on the device's clock, ms. */
function untilMidnight(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1).getTime() - now.getTime();
}

/**
 * The trash panel is open; per browser, like the theme. A phone starts with
 * it closed whatever was left: there it is a sheet over half the screen, and
 * left open once it covered the outline at every start.
 */
const TRASH_OPEN = 'listik-trash-open';
/** Saved searches (the star in the search box), newest first; per browser, like the theme. */
const SAVED_SEARCHES = 'listik-saved-searches';
/** Saved searches kept at most: saving one more lets the oldest go. */
export const SAVED_MAX = 20;
/** Places gone to lately, kept at most (the search box shows fewer). */
const RECENT_MAX = 20;

function readSaved(): string[] {
  try {
    const list: unknown = JSON.parse(readSetting(SAVED_SEARCHES) ?? '[]');
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string' && !!q.trim()).slice(0, SAVED_MAX) : [];
  } catch {
    return [];
  }
}

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the setting lasts for this page.
  }
}

/**
 * Where the caret goes: a text offset, or a horizontal position on the row's
 * first/last line (↑/↓). `id` is a row's key (model/rows.ts: a bullet under
 * a mirror shows in a row of its own).
 */
export type FocusRequest = Focus | { id: NodeId; x: number; line: 'first' | 'last'; note?: true };

/** What of the zoom title is being edited (ZoomHeader.tsx) and where the caret goes; null when neither. */
export type TitleEdit = { note: boolean; caret: number } | null;

/** What the places line (GoTo.tsx) is open for: going to a place, or moving rows into one. */
export type PlaceLine = { kind: 'go' } | { kind: 'move'; keys: RowKey[]; label: string };

/** Several rows selected: from `anchor` (where it started) to `head` (the moving end). */
export interface Selection {
  anchor: RowKey;
  head: RowKey;
}

/** The active search: what was asked and what it found when applied. */
export interface SearchFilter {
  query: Query;
  matches: ReadonlySet<NodeId>;
  count: number;
}

/** Glue between the model and the view: the doc, its derived state and the reactive handles the UI reads. */
export class Outliner {
  readonly doc: Doc;
  readonly rows: VisibleRows;
  readonly tags: TagIndex;
  readonly text: TextIndex;
  /** Open tasks, and the first one inside any bullet (model/tasks.ts). */
  readonly tasks: PendingTasks;
  /** Changes whenever open tasks, or where they lie, may have changed. */
  readonly tasksVersion: Accessor<number>;
  private setTasksVersion: Setter<number>;
  /** `[[title]]` → its bullet, for the task under a row with a link; misses kept for one tasks version. */
  private linkCache = new Map<string, { id: NodeId | null; version: number }>();
  readonly ctx: Ctx;
  readonly history = new History();
  readonly nodes = new NodeSignals();
  /** Changes whenever the visible rows change. */
  readonly rowsVersion: Accessor<number>;
  /** The row being edited; null when nothing is. A new object on every request, even for the same row. */
  readonly focus: Accessor<FocusRequest | null>;
  /** The text in the search box. */
  readonly query: Accessor<string>;
  /** The applied search; null shows the whole outline. */
  readonly filter: Accessor<SearchFilter | null>;
  /** Bumped to move the caret into the search box (Ctrl+F). */
  readonly searchRequests: Accessor<number>;
  /** The zoomed-in bullet, whose children are the top level; null for the whole outline. */
  readonly zoom: Accessor<NodeId | null>;
  /** Bumped to move the caret into the zoomed-in bullet's title. */
  readonly titleRequests: Accessor<number>;
  /** The last link followed: into which bullet, from which (its backlinks lead with that place). */
  readonly cameFrom: Accessor<{ to: NodeId; from: NodeId } | null>;
  private setCameFrom: Setter<{ to: NodeId; from: NodeId } | null>;
  /** The zoom title or its note being edited: the editing bar (EditBar.tsx) serves them too. */
  readonly titleEdit: Accessor<TitleEdit>;
  private setTitleEdit: Setter<TitleEdit>;
  /** Bumped to open the keyboard shortcuts panel. */
  readonly helpRequests: Accessor<number>;
  private setHelpRequests: Setter<number>;
  /** Bumped by `goHome`: the view scrolls back to the top. */
  readonly homeRequests: Accessor<number>;
  /** A short message at the bottom of the screen (import results, errors). */
  readonly toast: Accessor<string | null>;
  /** A button in the toast ("Отменить"), while it shows. */
  readonly toastAction: Accessor<{ label: string; run: () => void } | null>;
  private setToastAction: Setter<{ label: string; run: () => void } | null>;
  /** A word of the toast's own that leads somewhere (the "Inbox" of "Записано в Inbox"), after its text. */
  readonly toastLink: Accessor<{ label: string; run: () => void } | null>;
  private setToastLink: Setter<{ label: string; run: () => void } | null>;
  /**
   * A row's menu of actions (RowMenu.tsx), where it was asked for: a finger
   * held on the row and lifted without moving it (drag.ts), or a right click.
   */
  readonly rowMenu: Accessor<{ key: RowKey; x: number; y: number } | null>;
  private setRowMenu: Setter<{ key: RowKey; x: number; y: number } | null>;
  /** Sketches shown or hidden by hand this session (the "Скетч" button), by bullet; the rest show when they have lines. */
  private readonly sketchToggled: Accessor<ReadonlyMap<NodeId, boolean>>;
  private setSketchToggled: Setter<ReadonlyMap<NodeId, boolean>>;
  /** The quick capture line (QuickCapture.tsx) is open: a thought to the Inbox from anywhere. */
  readonly captureOpen: Accessor<boolean>;
  private setCaptureOpen: Setter<boolean>;
  /** What was typed in the capture line and closed unsaved (Esc): it is there again next time. */
  captureDraft = '';
  /** Where the caret was in the outline when the capture line opened: it goes back there. */
  private captureBack: FocusRequest | null = null;
  readonly selection: Accessor<Selection | null>;
  /** The trash panel (Trash.tsx) is open beside the outline. */
  readonly trashOpen: Accessor<boolean>;
  private setTrashOpen: Setter<boolean>;
  /** Saved searches, newest first (SearchBar.tsx): the star saves what is typed, focus lists them. */
  readonly savedSearches: Accessor<string[]>;
  private setSavedSearches: Setter<string[]>;
  /** Places zoomed into lately, newest first, calendar periods aside: the places line offers them before anything is typed. */
  readonly recentPlaces: Accessor<NodeId[]>;
  private setRecentPlaces: Setter<NodeId[]>;
  /** Where bullets were moved to lately ("Переместить в…"), newest first: offered first next time. */
  readonly recentTargets: Accessor<NodeId[]>;
  private setRecentTargets: Setter<NodeId[]>;
  /** The document's name for the keys `recentPlaces` and `recentTargets` last under on this device (`keepRecent`); null: for this page only. */
  private recentName: string | null = null;
  /** The places line (GoTo.tsx): "Перейти к…", or "Переместить в…" with the rows to move and what the line says of them; null: closed. */
  readonly placeLine: Accessor<PlaceLine | null>;
  private setPlaceLine: Setter<PlaceLine | null>;
  /** Where the caret was when the places line opened: it goes back there if the line closes with nothing done. */
  private placeBack: FocusRequest | null = null;
  /** Rows being dragged (with their subtrees), shown dimmed. */
  readonly dragged: Accessor<ReadonlySet<RowKey>>;
  readonly setDragged: Setter<ReadonlySet<RowKey>>;
  /** Automatic copies into a folder; null for in-memory documents. */
  backup: Backup | null = null;
  /** The stored document's persistence; null for in-memory documents. */
  persistence: Persistence | null = null;
  /** The document's database, sync settings and keys; null for in-memory documents. */
  opened: Opened | null = null;
  /** The live sync session, once sync is set up in the writing tab. Not reactive: read `syncing()` first. */
  syncHandle: SyncHandle | null = null;
  /** What the sync engine reports; `stopped` when there is none. */
  readonly syncStatus: Accessor<SyncStatus>;
  private setSyncStatus: Setter<SyncStatus>;
  private unwatchSync: (() => void) | null = null;
  /**
   * The server has been heard from since the start (or there is no sync):
   * only then does a calendar year or a day's template go in, lest a device
   * not yet up to date add a second one beside another device's.
   */
  private synced = false;
  /** A year or a day's template, waiting for `synced`. */
  private afterSync: (() => void)[] = [];
  /**
   * Bullets whose text is being erased, with the text they had before. One
   * erased to nothing and then deleted (Backspace from the end of the line,
   * then on the empty bullet) goes to the trash whole: `keepErased` gives
   * it that text back there. Typing more forgets it.
   */
  private erased = new Map<NodeId, string>();
  /**
   * The bullet whose text is being typed, with the text it had before:
   * once editing moves on (`settleTitle`), links to its old title follow it
   * to the new one.
   */
  private retitled: { id: NodeId; before: string } | null = null;
  /** The day `goToday` went into, and on what date: the next morning it leads on to the new day. */
  private today: { day: NodeId; date: string } | null = null;
  /** The document's name on this device (App.tsx): keys what is done once a day here. */
  docName = '';
  /** Today's date (`toDateString`), moved on at midnight and on coming back (`resumed`): stars and the marks of days follow it. */
  readonly date: Accessor<string>;
  private setDate: Setter<string>;
  /** Bumped to open the sync dialog. */
  readonly syncRequests: Accessor<number>;
  private setSyncRequests: Setter<number>;
  /** Another tab holds the document: nothing here may change it. */
  readonly readOnly: boolean;
  /** `?empty`: a new document stays a lone empty bullet, without the structure (tests start from it). */
  bare = false;
  private setRowsVersion: Setter<number>;
  private setFocusSignal: Setter<FocusRequest | null>;
  private setQuerySignal: Setter<string>;
  private setFilterSignal: Setter<SearchFilter | null>;
  private setSearchRequests: Setter<number>;
  private setZoomSignal: Setter<NodeId | null>;
  private setTitleRequests: Setter<number>;
  private setHomeRequests: Setter<number>;
  private setToast: Setter<string | null>;
  private setSelectionSignal: Setter<Selection | null>;
  private selectionCache: { selection: Selection; version: number; set: Set<RowKey>; roots: RowKey[] } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last check of each task (by its content), while it waits to go last: an earlier one, unchecked since, does not move it. */
  private lastCheck = new Map<NodeId, Sinking>();
  private pendingSearch: number | null = null;

  constructor(doc: Doc, options: { readOnly?: boolean } = {}) {
    this.doc = doc;
    this.readOnly = options.readOnly ?? false;
    this.rows = new VisibleRows(doc);
    this.tags = new TagIndex(doc);
    this.text = new TextIndex(doc);
    this.tasks = new PendingTasks(doc);
    [this.tasksVersion, this.setTasksVersion] = createSignal(this.tasks.version);
    this.ctx = { doc, rows: this.rows };
    [this.rowsVersion, this.setRowsVersion] = createSignal(this.rows.version);
    [this.focus, this.setFocusSignal] = createSignal<FocusRequest | null>(null, { equals: false });
    [this.query, this.setQuerySignal] = createSignal('');
    [this.filter, this.setFilterSignal] = createSignal<SearchFilter | null>(null);
    [this.searchRequests, this.setSearchRequests] = createSignal(0);
    [this.zoom, this.setZoomSignal] = createSignal<NodeId | null>(null);
    [this.titleRequests, this.setTitleRequests] = createSignal(0);
    [this.titleEdit, this.setTitleEdit] = createSignal<TitleEdit>(null);
    [this.cameFrom, this.setCameFrom] = createSignal<{ to: NodeId; from: NodeId } | null>(null);
    [this.homeRequests, this.setHomeRequests] = createSignal(0);
    [this.helpRequests, this.setHelpRequests] = createSignal(0);
    [this.syncRequests, this.setSyncRequests] = createSignal(0);
    [this.syncStatus, this.setSyncStatus] = createSignal<SyncStatus>({ phase: 'stopped', pending: 0, head: 0 });
    [this.toast, this.setToast] = createSignal<string | null>(null);
    [this.toastAction, this.setToastAction] = createSignal<{ label: string; run: () => void } | null>(null);
    [this.toastLink, this.setToastLink] = createSignal<{ label: string; run: () => void } | null>(null);
    [this.captureOpen, this.setCaptureOpen] = createSignal(false);
    [this.date, this.setDate] = createSignal(new Date().toDateString());
    [this.sketchToggled, this.setSketchToggled] = createSignal<ReadonlyMap<NodeId, boolean>>(new Map());
    [this.rowMenu, this.setRowMenu] = createSignal<{ key: RowKey; x: number; y: number } | null>(null);
    [this.selection, this.setSelectionSignal] = createSignal<Selection | null>(null);
    [this.dragged, this.setDragged] = createSignal<ReadonlySet<RowKey>>(new Set());
    [this.savedSearches, this.setSavedSearches] = createSignal(readSaved());
    [this.recentPlaces, this.setRecentPlaces] = createSignal<NodeId[]>([]);
    [this.recentTargets, this.setRecentTargets] = createSignal<NodeId[]>([]);
    [this.placeLine, this.setPlaceLine] = createSignal<PlaceLine | null>(null);
    [this.trashOpen, this.setTrashOpen] = createSignal(readSetting(TRASH_OPEN) === '1' && !narrow());
    // Completed bullets are no longer hidden (that setting is gone): forget it.
    writeSetting('listik-hide-done', null);
    doc.subscribe(this.nodes);
    doc.subscribe({
      commit: () => {
        if (this.tasks.version !== this.tasksVersion()) this.setTasksVersion(this.tasks.version);
        // The zoomed-in bullet was deleted (or its creation undone): back to the whole outline.
        const z = this.zoom();
        if (z && (!doc.has(z) || !doc.inOutline(z))) this.zoomTo(null);
        this.syncRows();
        // A change from another device may have hidden the edited row.
        const cur = this.focus();
        if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
      },
    });
    // Ready before the first search in practice, without blocking input meanwhile.
    this.text.warmUpInIdle();
  }

  /** Moves the caret; editing a row ends a selection. */
  setFocus(f: FocusRequest | null): void {
    if (this.retitled && (!f || !this.doc.has(nodeOf(f.id)) || this.contentOf(f.id).id !== this.retitled.id)) this.settleTitle();
    batch(() => {
      if (f && this.selection()) this.setSelectionSignal(null);
      this.setFocusSignal(f);
    });
  }

  /** Selects rows from `anchor` to `head` (null clears); leaves editing. */
  select(selection: Selection | null): void {
    if (selection) this.settleTitle();
    batch(() => {
      this.setSelectionSignal(selection);
      if (selection) this.setFocusSignal(null);
    });
  }

  /** Shift+↑/↓ in a selection: moves its head one row. */
  extendSelection(step: -1 | 1): void {
    const s = this.selection();
    if (!s) return;
    const i = this.rows.indexOf(s.head) + step;
    if (i >= 0 && i < this.rows.length) this.select({ anchor: s.anchor, head: this.rows.ids[i] });
  }

  /** The selected rows: from anchor to head, widened to whole subtrees. Reactive. */
  selectedSet(): ReadonlySet<RowKey> {
    return this.selectionInfo().set;
  }

  /** Selected rows not inside another selected one, in order: what block commands act on. */
  selectionRoots(): RowKey[] {
    return this.selectionInfo().roots;
  }

  /** Does the row show one of two or more copies of a bullet (model/mirrors.ts)? Backspace at its start takes out that copy alone. */
  isCopy(key: RowKey): boolean {
    const id = nodeOf(key);
    return !!this.doc.nodes.get(id)?.mirrorOf || this.doc.isCopy(id);
  }

  /** What the row shows: its bullet, or a mirror's original (model/mirrors.ts). */
  contentOf(key: RowKey) {
    return this.doc.content(nodeOf(key));
  }

  private selectionInfo(): { set: Set<RowKey>; roots: RowKey[] } {
    const selection = this.selection();
    const version = this.rowsVersion();
    if (!selection) return { set: new Set(), roots: [] };
    const cache = this.selectionCache;
    if (cache && cache.selection === selection && cache.version === version) return cache;
    const a = this.rows.indexOf(selection.anchor);
    const h = this.rows.indexOf(selection.head);
    const set = new Set<RowKey>();
    const roots: RowKey[] = [];
    if (a >= 0 && h >= 0) {
      const start = Math.min(a, h);
      let end = Math.max(a, h) + 1;
      // A root is a row outside the subtrees of the roots before it.
      let rootEnd = start;
      for (let i = start; i < end; i++) {
        const sub = this.rows.subtreeEnd(i);
        end = Math.max(end, sub);
        const key = this.rows.ids[i];
        set.add(key);
        if (i >= rootEnd) {
          roots.push(key);
          rootEnd = sub;
        }
      }
    }
    this.selectionCache = { selection, version, set, roots };
    return this.selectionCache;
  }

  /**
   * Sets the search text. The search itself runs once per frame however fast
   * the typing (or right away with `now`), and its cost depends on the
   * number of bullets scanned, never on rendering them all.
   */
  setQuery(text: string, now = false): void {
    this.setQuerySignal(text);
    if (this.pendingSearch !== null) cancelAnimationFrame(this.pendingSearch);
    this.pendingSearch = null;
    if (now) this.applyQuery();
    else this.pendingSearch = requestAnimationFrame(() => {
      this.pendingSearch = null;
      this.applyQuery();
    });
  }

  /** Is this search (as typed, spaces at the ends aside) among the saved ones? */
  isSaved(query: string): boolean {
    return this.savedSearches().includes(query.trim());
  }

  /** The star: saves the search, first in the list, or takes it out again. Beyond SAVED_MAX the oldest goes. */
  toggleSaved(query: string): void {
    const q = query.trim();
    if (!q) return;
    const list = this.savedSearches();
    let next: string[];
    if (list.includes(q)) next = list.filter((s) => s !== q);
    else {
      next = [q, ...list];
      if (next.length > SAVED_MAX) {
        next = next.slice(0, SAVED_MAX);
        this.notify(`В избранном не больше ${SAVED_MAX} поисков: самый старый убран`);
      }
    }
    this.setSavedSearches(next);
    writeSetting(SAVED_SEARCHES, next.length ? JSON.stringify(next) : null);
  }

  /** A click on a tag: search for it. */
  filterByTag(tag: string): void {
    this.setQuery(tagText(tag), true);
  }

  /**
   * A click on a `[[link]]`: zoom into the bullet it names, where it really
   * is in the outline (model/links.ts). A search is cleared, so all of it
   * shows. `from`, the row clicked in, is remembered: its place leads the
   * backlinks there (Backlinks.tsx), the way back. A link to nothing yet
   * makes its bullet, last in the structure's Inbox (one undo step).
   */
  followLink(title: string, from?: RowKey): void {
    this.settleTitle();
    let id = resolveLink(this.doc, this.text, title);
    const inbox = id ? null : findInbox(this.doc);
    if (!id && inbox !== null && !this.readOnly) {
      this.run((ctx) => void appendTrees(ctx, inbox, [{ text: title.trim(), children: [] }]), this.keepFocus());
      id = resolveLink(this.doc, this.text, title);
    }
    if (!id) return this.notify(`Нет пункта «${title.trim()}»`);
    batch(() => {
      this.setQuery('', true);
      this.setFocus(null);
      this.zoomTo(id);
      this.setCameFrom(from !== undefined && this.doc.has(nodeOf(from)) ? { to: this.doc.origin(id), from: this.contentOf(from).id } : null);
    });
  }

  /**
   * A backlink taken: to the place where the link stands (its bullet's
   * parent, zoomed into, or the whole outline), the caret on that bullet
   * right after the link.
   */
  goToBacklink(id: NodeId, target: NodeId): void {
    if (!this.doc.has(id)) return;
    const n = this.doc.get(id);
    const end = linkEnd(n.text, this.doc.get(target).text);
    batch(() => {
      this.zoomTo(n.parent === this.doc.root ? null : n.parent);
      const key = this.rows.locate(id);
      if (key) this.setFocus({ id: key, caret: end < 0 ? 0 : end });
    });
  }

  /**
   * Zoom into a bullet: it becomes the title, its children the top level.
   * A search in progress is cleared: you went to a place found, so it shows
   * whole (a search started inside a zoom covers only that bullet). With
   * `keepSearch` (a crumb: up the path), the search stays and runs again
   * over the new place, so its results show level after level. A bullet
   * zoomed into opens folded: everything inside it, at any depth (the
   * command `collapseAll`, no undo step), so the place reads as an overview.
   * It stays folded as left; only a day's `todo` stays open: the day's
   * list is what the day is entered for. `keepFolds` (a reload coming back to its place) shows it
   * as it was.
   */
  zoomTo(key: RowKey | null, keepSearch = false, keepFolds = false): void {
    this.settleTitle();
    let id = key && nodeOf(key);
    // A mirror has no inside of its own: zooming into it leads to the original (model/mirrors.ts).
    if (id && this.doc.has(id)) id = this.doc.origin(id);
    const target = id && id !== this.doc.root && this.doc.has(id) ? id : null;
    if (target === this.zoom()) return;
    batch(() => {
      // The new top first: under the filter that rebuild lists only the paths, and the clear then lists the place.
      this.rows.setTop(target ?? this.doc.root);
      this.setZoomSignal(target);
      if (this.query() || this.filter()) this.setQuery(keepSearch ? this.query() : '', true);
      // Folded once the rows are the place's: a rebuild of only what is inside it, not of the list left.
      if (target && !keepFolds) {
        this.scaffold((ctx) => {
          collapseAll(ctx, target);
          const todo = periodAt(this.doc, target)?.kind === 'day' ? todoOf(this.doc, target) : null;
          if (todo !== null && this.doc.get(todo).collapsed) setCollapsed(ctx, todo, false);
        });
      }
      this.syncRows();
      const cur = this.focus();
      if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
    });
    if (target) {
      this.enterDay(target);
      this.visited(target);
    }
  }

  /** A place zoomed into goes first among the recent ones; calendar periods are reached by «Сегодня», `#secret` ones through the outline only. */
  private visited(id: NodeId): void {
    if (periodAt(this.doc, id) || !searchable(this.doc, id)) return;
    this.remember(id, this.recentPlaces, this.setRecentPlaces, 'listik-recent');
  }

  /** `id` first in a list of recent ones, kept on this device under `prefix:<document>`. */
  private remember(id: NodeId, list: Accessor<NodeId[]>, set: Setter<NodeId[]>, prefix: string): void {
    const next = [id, ...list().filter((r) => r !== id)].slice(0, RECENT_MAX);
    set(next);
    if (this.recentName !== null) writeSetting(`${prefix}:${this.recentName}`, JSON.stringify(next));
  }

  /** The recent places and move targets last on this device for the document `name`, as the folds do. */
  /**
   * Once per document on this device: the calendar's years, months and weeks
   * made open by earlier versions get folded, as new ones are made
   * (model/calendar.ts `openPeriods`). Folding stays on the device, so each
   * device does it once; no undo step.
   */
  foldCalendar(name: string): void {
    const key = `listik-calendar-folded:${name}`;
    if (this.readOnly || readSetting(key)) return;
    const open = openPeriods(this.doc);
    if (open.length) this.scaffold((ctx) => {
      for (const id of open) setCollapsed(ctx, id, true);
    });
    writeSetting(key, '1');
  }

  /**
   * Year tags written by earlier versions become what the app writes now
   * (model/calendar.ts `yearTags`): a year `@y2026` is renamed `@y26`, a day
   * without its year gets it, so `@y26` filters them like every period made
   * since. With sync, once the server has been heard from, so a bullet
   * another device already fixed is not fixed twice; the same change made
   * on two devices at once merges into one. No undo step.
   */
  tagYears(): void {
    const run = () => {
      const fixes = yearTags(this.doc);
      if (fixes.length) this.scaffold((ctx) => {
        for (const { id, text } of fixes) setText(ctx, id, text);
      });
    };
    if (this.readOnly) return;
    if (this.syncing() && !this.synced) this.afterSync.push(run);
    else run();
  }

  keepRecent(name: string): void {
    this.recentName = name;
    const read = (prefix: string, set: Setter<NodeId[]>) => {
      try {
        const list: unknown = JSON.parse(readSetting(`${prefix}:${name}`) ?? '[]');
        if (Array.isArray(list)) set(list.filter((id): id is string => typeof id === 'string').slice(0, RECENT_MAX));
      } catch {
        // Unreadable: none yet.
      }
    };
    read('listik-recent', this.setRecentPlaces);
    read('listik-recent-targets', this.setRecentTargets);
  }

  /**
   * Where the caret is in the outline, read off the page: the focus request
   * is where editing began, and typing has moved on since. A line over the
   * outline (quick capture, places) puts it back there as it closes.
   */
  private caretNow(): FocusRequest | null {
    const el = document.activeElement as HTMLElement | null;
    const f = this.focus();
    const offset = f && el?.isContentEditable && el.closest('.row') ? selectionIn(el)?.[0] : undefined;
    return f && offset !== undefined ? (el!.classList.contains('note') ? { id: f.id, caret: offset, note: true } : { id: f.id, caret: offset }) : f;
  }

  /**
   * Ctrl+K: the places line opens as "Перейти к…" (GoTo.tsx), a place to
   * go to by its name; the search and the outline stay as they are. Works
   * read-only too: it only goes.
   */
  openGoTo(): void {
    if (this.placeLine()) return;
    this.settleTitle();
    this.placeBack = this.caretNow();
    this.setPlaceLine({ kind: 'go' });
  }

  /**
   * Ctrl+Shift+M, "Куда…" on the editing bar: the places line opens as
   * "Переместить в…" for these rows (GoTo.tsx). The outline stays as it is.
   */
  openMove(keys: RowKey[]): void {
    if (this.readOnly || !keys.length) return;
    this.settleTitle();
    this.placeBack = this.caretNow();
    const first = titleOf(this.contentOf(keys[0]).text) || 'пустой пункт';
    this.setPlaceLine({ kind: 'move', keys, label: keys.length > 1 ? `${keys.length} ${plural(keys.length, 'пункт', 'пункта', 'пунктов')}` : `«${first}»` });
  }

  /** The rows "Переместить в…" is open for, and what the line says of them; null: it is not. */
  moving(): { keys: RowKey[]; label: string } | null {
    const line = this.placeLine();
    return line?.kind === 'move' ? line : null;
  }

  /** The places line closes with nothing done (Esc, a press outside): the caret goes back where it was. */
  closePlaceLine(): void {
    if (!this.placeLine()) return;
    this.setPlaceLine(null);
    const back = this.placeBack;
    this.placeBack = null;
    if (back && this.rows.indexOf(back.id) >= 0) this.setFocus({ ...back });
  }

  /**
   * Whether a bullet cannot take what is being moved: it is one of the
   * moved bullets or inside one (its original, for a mirror). Places the
   * line offers leave these out.
   */
  moveRefuses(id: NodeId): boolean {
    const m = this.moving();
    const host = this.doc.host(id)?.id;
    return !m || host === undefined || m.keys.some((k) => this.doc.within(host, nodeOf(k)));
  }

  /**
   * A place taken in "Переместить в…": the rows' bullets go last into it
   * (model/commands.ts `moveManyInto`), one undo step. The caret stays here,
   * on the row that now follows (or else precedes) where they were, so the
   * next one can go too; the toast names the place and leads there.
   */
  moveInto(target: NodeId): void {
    const m = this.moving();
    if (!m || this.readOnly) return;
    this.setPlaceLine(null);
    const back = this.placeBack;
    this.placeBack = null;
    const keys = m.keys.filter((k) => this.rows.indexOf(k) >= 0);
    if (!keys.length) return;
    // The row after the moved block (a selection is one), or the one before it.
    const at = keys.map((k) => this.rows.indexOf(k));
    const end = Math.max(...at.map((i) => this.rows.subtreeEnd(i)));
    const next = this.rows.ids[end] ?? this.rows.ids[Math.min(...at) - 1] ?? null;
    const after: Focus | undefined = next ? { id: next, caret: this.contentOf(next).text.length } : undefined;
    const moved = keys.map(nodeOf);
    let count = 0;
    const ops = this.run((ctx) => {
      count = moveManyInto(ctx, keys, target);
      return count ? after : undefined;
    }, back && 'caret' in back ? back : undefined);
    if (!count) return this.notify('Сюда переместить нельзя: это внутри перемещаемого');
    if (this.selection()) this.select(null);
    if (!after) this.setFocus(null);
    const place = this.doc.origin(target);
    this.remember(place, this.recentTargets, this.setRecentTargets, 'listik-recent-targets');
    const name = plainText(this.doc.get(place).text).trim() || 'пункт без названия';
    this.notify(count > 1 ? `${count} ${plural(count, 'пункт перемещён', 'пункта перемещены', 'пунктов перемещены')} в` : 'Перемещено в', {
      label: 'Отменить',
      run: () => this.takeBack(ops, 'Перемещение отменено'),
    }, {
      label: name.length > 40 ? name.slice(0, 39) + '…' : name,
      run: () => {
        this.hideToast();
        if (this.doc.has(moved[0]) && this.doc.inOutline(moved[0])) this.goToTask(moved[0]);
      },
    });
  }

  /** A toast's "Отменить": the ops undone, unless the document has changed under them; one undo step itself. */
  private takeBack(ops: Op[], message: string): void {
    try {
      const back = this.doc.transact(() => [...ops].reverse().forEach((op) => this.doc.apply(invert(op))));
      this.history.record({ ops: back, before: null, after: null });
    } catch {
      // Changed since: what is there now stays.
    }
    this.notify(message);
  }

  /**
   * A place taken in "Перейти к…": the line closes, a search goes, and the
   * view zooms into it. With `edit` (the keyboard) the caret goes on into
   * its first bullet, or its title, as Alt+→ does.
   */
  goToPlace(id: NodeId, edit: boolean): void {
    if (!this.doc.has(id) || !searchable(this.doc, id)) return;
    this.setPlaceLine(null);
    this.placeBack = null;
    batch(() => {
      this.setQuery('', true);
      this.setFocus(null);
      if (edit) this.zoomIn(id);
      else this.zoomTo(id);
    });
  }

  /** "Сегодня" taken in "Перейти к…": the line closes, and the view goes into today's day as «Сегодня» leads. */
  goToTodayPlace(): void {
    this.setPlaceLine(null);
    this.placeBack = null;
    this.goToday();
  }

  /**
   * A day of the calendar entered for the first time, by any way: its
   * template goes in (model/calendar.ts `fillDay`, no undo step: `scaffold`),
   * the caret stays out. With sync, only once the server has been heard from, and
   * only if the day is still where the user is.
   */
  private enterDay(id: NodeId): void {
    if (this.readOnly || this.doc.get(id).children.length || periodAt(this.doc, id)?.kind !== 'day') return;
    const fill = () => {
      if (this.zoom() !== id || !this.doc.has(id)) return;
      this.scaffold((ctx) => fillDay(ctx, id));
    };
    if (this.syncing() && !this.synced) this.afterSync.push(fill);
    else fill();
  }

  /**
   * The calendar the app builds by itself as you go (a year stepped into, a
   * day's template, the structure a first sync finds missing): applied and
   * saved, but no undo step. As one, Ctrl+Z after "Сегодня" or ‹ › took the
   * new year away, and the view with it, instead of the last edit. Unwanted,
   * it goes like any bullets. The caret stays where it is.
   */
  private scaffold(cmd: (ctx: Ctx) => void): void {
    if (this.readOnly) return;
    batch(() => {
      this.doc.transact(() => cmd(this.ctx));
    });
  }

  /** The caret where it is, for a command that should not move it. */
  private keepFocus(): Focus | undefined {
    const f = this.focus();
    return f && 'caret' in f ? f : undefined;
  }

  /**
   * Makes sure the calendar has the period's year (model/calendar.ts
   * `addYear`, no undo step: `scaffold`), and finds the period. With sync, a missing
   * year waits for the server: null then.
   */
  private periodBullet(p: Period): NodeId | null {
    const found = findPeriod(this.doc, this.tags, p);
    if (found !== null || this.readOnly || findPeriod(this.doc, this.tags, quarterPeriod(p)) !== null) return found;
    if (this.syncing() && !this.synced) return null;
    this.scaffold((ctx) => void addYear(ctx, this.tags, p.y));
    return findPeriod(this.doc, this.tags, p);
  }

  /**
   * «Сегодня» in the header, and the start: into today's day in the calendar
   * (model/calendar.ts), its year made first if this is the first time in
   * it. The caret stays out. `quiet` (the start) says nothing when there is
   * no structure or no such day.
   */
  goToday(quiet = false): void {
    const now = new Date();
    const today = dayOf(now);
    if (!this.structure()) return quiet ? undefined : this.notify('Структуры ещё нет: меню «⋯» → «Создать структуру»');
    const day = this.periodBullet(today);
    if (!day) {
      // A new year waits for the server: then here, if nothing else was done meanwhile.
      if (this.syncing() && !this.synced) {
        const zoom = this.zoom();
        this.afterSync.push(() => this.zoom() === zoom && !this.focus() && this.goToday(true));
        return;
      }
      return quiet ? undefined : this.notify(`В календаре нет дня ${periodName(today)}`);
    }
    batch(() => {
      this.setQuery('', true);
      this.setFocus(null);
      this.zoomTo(day);
    });
    this.today = { day, date: now.toDateString() };
  }

  /**
   * The Inbox button: into the structure's Inbox, made last at the top level
   * if there is none (not an undo step, as the calendar the app builds). The
   * caret stays out, as after "Сегодня".
   */
  goInbox(): void {
    let inbox = findInbox(this.doc);
    if (inbox === null) {
      if (this.readOnly) return this.notify('Inbox ещё нет');
      this.scaffold((ctx) => void appendTrees(ctx, this.doc.root, [{ text: 'Inbox', children: [] }]));
      inbox = findInbox(this.doc);
      if (inbox === null) return;
    }
    const id = inbox;
    batch(() => {
      this.setQuery('', true);
      this.setFocus(null);
      this.zoomTo(id);
    });
  }

  /** Where the header's places lead, if the view is there: today's day or the Inbox. Reactive. */
  placeNow(): 'today' | 'inbox' | null {
    this.rowsVersion();
    const z = this.zoom();
    if (z === null || !this.doc.has(z)) return null;
    if (z === findInbox(this.doc)) return 'inbox';
    const p = periodAt(this.doc, z);
    const t = dayOf(new Date());
    return p?.kind === 'day' && t.kind === 'day' && p.y === t.y && p.m === t.m && p.d === t.d ? 'today' : null;
  }

  /** How many bullets wait in the Inbox (its first level); null without one. Reactive. */
  inboxCount(): number | null {
    this.rowsVersion();
    const inbox = findInbox(this.doc);
    return inbox === null ? null : this.doc.get(inbox).children.length;
  }

  /** Today, on the device's clock. */
  todayDate(): DayDate {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }

  /**
   * The day for a step: found in the calendar, its year made first, its
   * template put in if it is new (model/calendar.ts; neither is an undo step:
   * `scaffold`). Null, with a word to the user, when there is none to be had.
   */
  private dayFor(date: DayDate): NodeId | null {
    if (!this.structure()) {
      this.notify('Структуры ещё нет: меню «⋯» → «Создать структуру»');
      return null;
    }
    const p: Period = { kind: 'day', ...date };
    const waiting = this.syncing() && !this.synced;
    const day = this.periodBullet(p);
    if (day === null || (waiting && !this.doc.get(day).children.length)) {
      this.notify(waiting ? 'День ещё не пришёл с сервера: попробуйте через минуту' : `В календаре нет дня ${periodName(p)}`);
      return null;
    }
    if (!this.doc.get(day).children.length) this.scaffold((ctx) => fillDay(ctx, day));
    return day;
  }

  /** The day of the calendar the zoom is in (the day itself, not a week or a month); null elsewhere. Reactive. */
  zoomDay(): DayDate | null {
    this.rowsVersion();
    const z = this.zoom();
    const p = z && this.doc.has(z) ? periodAt(this.doc, z) : null;
    return p?.kind === 'day' ? { y: p.y, m: p.m, d: p.d } : null;
  }

  /**
   * ‹ › in a day: the day before (-1) or after (+1) by the calendar, across
   * weeks, months and years. The day comes first if it is not there: its year
   * and template as planning makes them (`dayFor`, no undo step). Also
   * Ctrl+Alt+←/→ (Outline.tsx). Returns whether the zoom is in a day.
   */
  stepDay(step: -1 | 1): boolean {
    const date = this.zoomDay();
    if (!date) return false;
    this.goToDate(addDays(date, step));
    return true;
  }

  /** The view into the day of a date, as «Сегодня» leads into today. */
  private goToDate(date: DayDate): void {
    if (sameDate(date, this.todayDate())) return this.goToday();
    const day = this.dayFor(date);
    if (day === null) return;
    batch(() => {
      this.setQuery('', true);
      this.setFocus(null);
      this.zoomTo(day);
    });
  }

  /** After a reload in today's day: the next morning still leads on to the new day (`resumed`), as after the logo. */
  stayedToday(): void {
    const z = this.zoom();
    const p = z && this.doc.has(z) ? periodAt(this.doc, z) : null;
    const now = new Date();
    const t = dayOf(now);
    if (p?.kind === 'day' && t.kind === 'day' && p.y === t.y && p.m === t.m && p.d === t.d) this.today = { day: z!, date: now.toDateString() };
  }

  /** The app comes back into view: still in yesterday's day, it goes on to today's. */
  resumed(): void {
    const now = new Date().toDateString();
    if (this.date() !== now) {
      this.setDate(now);
    }
    const t = this.today;
    if (t && t.date !== new Date().toDateString() && this.zoom() === t.day) this.goToday(true);
  }

  /**
   * Midnight with the app left open in view (a computer's window all
   * night): no coming back to it for `resumed` to catch, so a timer goes on
   * to the new day. Not under the caret: a bullet being edited keeps its
   * day, and the step is tried again a minute later. Returns the way to stop.
   */
  watchMidnight(): () => void {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        if (this.focus()) return arm(MIDNIGHT_RETRY);
        this.resumed();
        arm(untilMidnight());
      }, ms);
    };
    arm(untilMidnight());
    return () => clearTimeout(timer);
  }

  /**
   * "Главная" over the list, on the home page: back to the top of the whole outline with every top-level
   * bullet folded, an overview at a glance. Search and zoom are left; the
   * folding is one undo step.
   */
  goHome(): void {
    batch(() => {
      this.setQuery('', true);
      this.zoomTo(null);
      this.toggleLevel();
      this.setFocus(null);
      this.setHomeRequests((n) => n + 1);
    });
  }

  /** What the place's own crumb last folded: pressed again, it opens just those. */
  private levelFolded: { parent: NodeId; ids: NodeId[] } | null = null;

  /**
   * The place's own crumb ("Главная" on the home page, the last one in a
   * zoom): every bullet of the first level here folded, an overview to find
   * the one wanted in. Pressed again with nothing left to fold, it opens
   * again what it folded (or, after other changes there, every one). One
   * undo step each.
   */
  toggleLevel(): void {
    const parent = this.zoom() ?? this.doc.root;
    const kids = this.doc.get(parent).children.filter((c) => (this.doc.host(c)?.children.length ?? 0) > 0);
    const open = kids.filter((c) => !this.doc.get(c).collapsed);
    if (open.length) {
      this.run((ctx) => collapseChildren(ctx, parent));
      this.levelFolded = { parent, ids: open };
      return;
    }
    const last = this.levelFolded;
    const ids = last?.parent === parent ? last.ids.filter((id) => kids.includes(id)) : kids;
    this.levelFolded = null;
    this.run((ctx) => {
      if (ids.length > 1) ctx.rows.expectMany();
      for (const id of ids) setCollapsed(ctx, id, false);
    });
  }

  /** Is the structure in the document (a quarter at the top level, model/calendar.ts)? Reactive. */
  structure(): boolean {
    this.rowsVersion();
    return hasStructure(this.doc, this.tags);
  }

  /**
   * The menu: the structure goes in at the end of the top level, whatever
   * is there already (one undo step), and the app goes to today in it.
   */
  createStructure(): void {
    if (this.readOnly) return;
    this.run((ctx) => void createStructure(ctx, new Date().getFullYear()));
    this.goToday();
  }

  /**
   * A new document's first start, or the first sync of one without the
   * structure (`bare` aside): the structure goes in, no undo step either way
   * (nobody asked for it: `scaffold`). At the start it takes the place of the
   * lone empty bullet.
   */
  firstStructure(start: boolean): void {
    if (this.readOnly || this.bare || this.structure()) return;
    if (!start) return this.scaffold((ctx) => void createStructure(ctx, new Date().getFullYear()));
    const [lone] = this.doc.get(this.doc.root).children;
    this.doc.transact(() => {
      createStructure(this.ctx, new Date().getFullYear());
      if (lone && this.doc.get(lone).text === '' && !this.doc.get(lone).children.length) deleteNode(this.ctx, lone);
    });
  }

  /** Alt+→: zoom into a bullet and edit its first child, or its title if it has none. */
  zoomIn(id: RowKey): void {
    batch(() => {
      this.zoomTo(id);
      const first = this.rows.ids[0];
      if (first) this.setFocus({ id: first, caret: 0 });
      // The title mounts with the new zoom: ask once it exists.
      else queueMicrotask(() => this.setTitleRequests((n) => n + 1));
    });
  }

  /** Alt+←: zoom out one level and edit the bullet we were in. */
  zoomOut(): void {
    const z = this.zoom();
    if (!z) return;
    batch(() => {
      this.zoomTo(this.doc.get(z).parent);
      this.setFocus({ id: z, caret: 0 });
    });
  }

  /**
   * How bullets fold under each mirror (model/rows.ts `folds`) lasts on this
   * device for the document `name`, as the theme does: read now, written
   * whenever it changes.
   */
  keepFolds(name: string): void {
    const key = `listik-folds:${name}`;
    try {
      const entries: unknown = JSON.parse(readSetting(key) ?? '[]');
      if (Array.isArray(entries)) this.rows.loadFolds(entries.filter((e): e is [string, boolean] => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'boolean'));
    } catch {
      // Unreadable: every mirror folds as its bullets do.
    }
    this.rows.onFolds = () => {
      const entries = this.rows.foldEntries();
      writeSetting(key, entries.length ? JSON.stringify(entries) : null);
    };
  }

  /** The menu: opens the trash panel beside the outline, or closes it; remembered per browser. */
  showTrash(open = !this.trashOpen()): void {
    this.setTrashOpen(open);
    writeSetting(TRASH_OPEN, open ? '1' : null);
  }

  /** What was deleted, newest first (model/trash.ts). Reactive. */
  deleted(): Deleted[] {
    this.rowsVersion();
    return deletedEntries(this.doc);
  }

  /**
   * "Вернуть" in the trash panel: the block goes back where it was (one undo
   * step), and the caret to the end of its text, there among its neighbours.
   * If that place is not on the screen, the view goes to it first.
   */
  restoreDeleted(id: NodeId): void {
    if (this.readOnly) return;
    const landed: { home: boolean }[] = [];
    batch(() => {
      this.run((ctx) => {
        const r = restoreDeleted(ctx, id);
        if (r) landed.push(r);
      }, this.keepFocus());
      if (!landed.length) return;
      const caret = this.doc.content(id).text.length;
      let key = this.rows.locate(id);
      if (!key) {
        const parent = this.doc.get(id).parent!;
        this.zoomTo(parent === this.doc.root ? null : parent);
        key = this.rows.locate(id);
      }
      if (key) this.setFocus({ id: key, caret });
    });
    if (landed.length && !landed[0].home) this.notify('Прежнего места уже нет: пункт вернулся в конец списка');
  }

  /**
   * The open task to show under a row (Row.tsx): the first one, top first,
   * inside its bullet (a mirror's: its original's) while they are out of
   * sight (folded, or kept out by a search), else the first of those its
   * `[[links]]` lead to (the linked bullet itself or inside it). `more` —
   * how many other open tasks there are. Reactive.
   */
  pendingFor(key: RowKey): { task: NodeId; more: number } | null {
    const version = this.tasksVersion();
    this.rowsVersion();
    const id = nodeOf(key);
    if (!this.doc.has(id)) return null;
    const host = this.doc.host(id);
    if (host && this.rows.hasHiddenChildren(key)) {
      const r = this.tasks.inside(host.id);
      if (r) return { task: r.task, more: r.count - 1 };
    }
    for (const m of this.doc.content(id).text.matchAll(LINK_RE)) {
      const target = this.linkTarget(m[1], version);
      if (target === null || target === id) continue;
      const own = this.tasks.isOpen(target);
      const r = this.tasks.inside(this.doc.host(target)?.id ?? target);
      if (own) return { task: target, more: r?.count ?? 0 };
      if (r) return { task: r.task, more: r.count - 1 };
    }
    return null;
  }

  /** Where `[[title]]` leads (`resolveLink`, a pass over every bullet), remembered while it still holds. */
  private linkTarget(title: string, version: number): NodeId | null {
    const key = normalize(title.trim());
    const hit = this.linkCache.get(key);
    if (hit?.id && this.doc.has(hit.id) && searchable(this.doc, hit.id) && normalize(titleOf(this.doc.get(hit.id).text)) === key) return hit.id;
    if (hit && hit.id === null && hit.version === version) return null;
    const id = resolveLink(this.doc, this.text, title);
    this.linkCache.set(key, { id, version });
    return id;
  }

  /** The checkbox of the task shown under a row: checked (and on its way last, `changeTasks`); the next open one takes its place there. */
  completeTask(task: NodeId): void {
    const n = this.doc.nodes.get(task);
    if (!n || !n.todo || n.done) return;
    this.changeTasks(({ doc }) => setDone(doc, doc.get(task), true), [task], this.keepFocus());
  }

  /** The text of the task shown under a row (or the "Inbox" of a capture's toast): to where it is, the caret at its end. */
  goToTask(task: NodeId): void {
    if (!this.doc.has(task)) return;
    const n = this.doc.get(task);
    batch(() => {
      this.zoomTo(n.parent === this.doc.root ? null : n.parent);
      const key = this.rows.locate(task);
      if (key) this.setFocus({ id: key, caret: this.doc.content(task).text.length });
    });
  }

  /** Ctrl+L: plain bullets become tasks; tasks are checked or unchecked. */
  cycleTask(ids: RowKey[], keep?: Focus): void {
    this.changeTasks((ctx) => cycleTask(ctx, ids), ids, keep);
  }

  /** Ctrl+Shift+L: tasks become plain bullets again. */
  untask(ids: RowKey[], keep?: Focus): void {
    this.changeTasks((ctx) => untask(ctx, ids), ids, keep);
  }

  /** A click on a task's checkbox: checked or unchecked. */
  toggleDone(ids: RowKey[], keep?: Focus): void {
    this.changeTasks((ctx) => toggleDone(ctx, ids), ids, keep);
  }

  /**
   * A row swiped to the left (swipe.ts): the bullet goes to the trash with
   * all it holds, however much that is; one undo step, and the toast can take
   * it back. A caret in another row stays there.
   */
  swipeDelete(key: RowKey): void {
    const i = this.rows.indexOf(key);
    if (this.readOnly || i < 0) return;
    const cur = this.focus();
    const at = cur ? this.rows.indexOf(cur.id) : -1;
    const keep = cur && 'caret' in cur && at >= 0 && (at < i || at >= this.rows.subtreeEnd(i)) ? cur : undefined;
    if (this.selection()) this.select(null);
    const ops = this.run((ctx) => {
      deleteNode(ctx, key);
      return keep;
    }, keep);
    this.notify('Удалено', { label: 'Отменить', run: () => this.takeBack(ops, 'Удаление отменено') });
  }

  /**
   * A press on a bullet that did not drag: a task's checkbox toggles; a plain
   * bullet zooms in.
   */
  pressBullet(id: RowKey): void {
    if (!this.contentOf(id).todo) return this.zoomTo(id);
    const cur = this.focus();
    this.toggleDone([id], cur && 'caret' in cur ? cur : undefined);
  }

  /**
   * Applies a change to tasks. Ones it checked off stay struck through where
   * they are for a moment (`SINK_DELAY`), then go last among their siblings
   * (`sink`). Each check waits its own full time: one unchecked and checked
   * again starts over, the earlier wait no longer counts (`lastCheck`).
   */
  private changeTasks(cmd: (ctx: Ctx) => void, ids: RowKey[], keep?: Focus): void {
    if (!ids.length) return;
    const ops = this.run(cmd, keep);
    const checked = new Set<NodeId>();
    for (const op of ops) {
      if (op.t !== 'setDone') continue;
      if (op.to) checked.add(op.id);
      else this.lastCheck.delete(op.id);
    }
    const sink = [...new Set(ids.map(nodeOf))].filter((id) => checked.has(this.doc.content(id).id));
    if (!sink.length) return;
    const at = new Map(sink.map((id) => [id, { parent: this.doc.get(id).parent, order: this.doc.get(id).order }]));
    const entry: Sinking = { ops, ids: sink, at, moved: [] };
    for (const id of checked) this.lastCheck.set(id, entry);
    setTimeout(() => this.sink(entry), SINK_DELAY);
  }

  /**
   * Checked-off tasks go last among their siblings (model/commands.ts
   * `sinkDone`), once, unless unchecked, checked again since, gone or moved
   * by hand meanwhile (the place chosen stays);
   * still the last step, the check takes the move into its undo. A caret in
   * one stays where it was in the list, on the row that comes up in its
   * place. Then the toast "Выполнено": its "Отменить" brings them back
   * unchecked where they were, not to be looked for at the end.
   */
  private sink(entry: Sinking): void {
    const ids = entry.ids.filter((id) => {
      if (!this.doc.has(id) || !this.doc.inOutline(id)) return false;
      const { parent, order } = this.doc.get(id);
      const was = entry.at.get(id)!;
      if (parent !== was.parent || order !== was.order) return false;
      const n = this.doc.content(id);
      return n.done && this.lastCheck.get(n.id) === entry;
    });
    for (const [id, e] of this.lastCheck) if (e === entry) this.lastCheck.delete(id);
    if (this.readOnly || !ids.length) return;
    batch(() => {
      const cur = this.focus();
      const at = cur ? this.rows.indexOf(cur.id) : -1;
      const leaving = cur !== null && ids.some((id) => this.doc.within(nodeOf(cur.id), id));
      entry.moved = this.doc.transact(() => sinkDone(this.ctx, ids));
      if (!entry.moved.length) return;
      if (!this.history.extend(entry.ops, entry.moved)) this.history.record({ ops: entry.moved, before: null, after: null });
      if (this.selection()) this.select(null);
      if (leaving) {
        const key = at >= 0 ? this.rows.ids[Math.min(at, this.rows.length - 1)] : undefined;
        this.setFocus(key ? { id: key, caret: 0 } : null);
      }
    });
    const n = new Set(ids.map((id) => this.doc.content(id).id)).size;
    this.notify(n > 1 ? `${n} ${plural(n, 'пункт выполнен', 'пункта выполнены', 'пунктов выполнены')}` : 'Выполнено', {
      label: 'Отменить',
      run: () => this.unsink(entry),
    });
  }

  /** The toast's "Отменить" for a check: the task unchecked, back where it was if it went last. */
  private unsink(entry: Sinking): void {
    this.takeBack([...entry.ops, ...entry.moved], 'Выполнение отменено');
  }

  /** Shows a message for a few seconds. */
  notify(message: string, action: { label: string; run: () => void } | null = null, link: { label: string; run: () => void } | null = null): void {
    batch(() => {
      this.setToast(message);
      this.setToastAction(action);
      this.setToastLink(link);
    });
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.hideToast(), 4000);
  }

  /** The toast goes (its time is up, or one of its buttons was taken). */
  hideToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    batch(() => {
      this.setToast(null);
      this.setToastAction(null);
      this.setToastLink(null);
    });
  }

  /**
   * Ctrl+Shift+Space, "Записать в Inbox" in the
   * menu: the quick capture line opens over the outline. Where the caret was
   * is read off the page first (the focus request is where editing began;
   * typing has moved on since), to go back there when the line closes.
   */
  openCapture(): void {
    if (this.readOnly) return;
    if (this.captureOpen()) return;
    this.captureBack = this.caretNow();
    this.setCaptureOpen(true);
  }

  /** The capture line closes: the caret goes back where it was in the outline. */
  closeCapture(): void {
    if (!this.captureOpen()) return;
    this.setCaptureOpen(false);
    const back = this.captureBack;
    this.captureBack = null;
    if (back && this.rows.indexOf(back.id) >= 0) this.setFocus({ ...back });
  }

  /**
   * The capture line's Enter: the thought goes last into the structure's
   * Inbox (one made at the end of the top level if there is none), one undo
   * step; the place in the outline stays as it was. The toast can take it
   * back.
   */
  capture(text: string): void {
    const t = text.trim();
    if (!t || this.readOnly) return;
    let made: NodeId | null = null;
    const ops = this.doc.transact(() => {
      let inbox = findInbox(this.doc);
      if (inbox === null) {
        appendTrees(this.ctx, this.doc.root, [{ text: 'Inbox', children: [] }]);
        inbox = findInbox(this.doc)!;
      }
      made = (appendTrees(this.ctx, inbox, [{ text: t, children: [] }]) as Focus).id;
    });
    this.history.record({ ops, before: null, after: null });
    const id = made!;
    this.notify('Записано в', {
      label: 'Отменить',
      run: () => {
        if (!this.doc.has(id) || !this.doc.inOutline(id)) return;
        this.takeBack(ops, 'Запись убрана');
      },
    }, {
      // To the note just made, to go on writing it.
      label: 'Inbox',
      run: () => {
        this.hideToast();
        if (this.doc.has(id) && this.doc.inOutline(id)) this.goToTask(id);
      },
    });
  }

  /** `?` or Ctrl+/: shows the keyboard shortcuts. */
  showHelp(): void {
    this.setHelpRequests((n) => n + 1);
  }

  /** Is sync set up (reactive)? */
  syncing(): boolean {
    return this.syncStatus().phase !== 'stopped';
  }

  /** The menu or the cloud icon: opens the sync dialog. */
  showSync(): void {
    this.setSyncRequests((n) => n + 1);
  }

  /** Follows the current sync engine's status (call after `syncHandle` changes). */
  watchSync(): void {
    this.unwatchSync?.();
    this.unwatchSync = null;
    const engine = this.syncHandle?.engine;
    if (!engine) {
      this.setSyncStatus({ phase: 'stopped', pending: 0, head: 0 });
      return this.heardFromServer();
    }
    this.setSyncStatus(engine.status);
    this.unwatchSync = engine.subscribe((s) => {
      this.setSyncStatus({ ...s });
      if (s.phase === 'synced' || s.phase === 'offline' || s.phase === 'error') this.heardFromServer();
    });
  }

  private heardFromServer(): void {
    this.synced = true;
    const pending = this.afterSync;
    this.afterSync = [];
    for (const fn of pending) fn();
  }

  /** Ctrl+F: put the caret into the search box. */
  requestSearch(): void {
    this.setSearchRequests((n) => n + 1);
  }

  /**
   * The search as a bullet's text shows it: its words and tags highlighted
   * only in a bullet found (all the words and tags of a clause are in it;
   * a mirror's row as its original), not in those shown above one as its
   * path, where a single word or tag would read as found too. Null: nothing
   * to highlight.
   */
  highlightFor(id: NodeId): Query | null {
    const f = this.filter();
    return f && this.doc.has(id) && f.matches.has(this.doc.origin(id)) ? f.query : null;
  }

  /** The first visible row that matches the search (a mirror's row matches as its original). */
  firstMatch(): RowKey | null {
    const f = this.filter();
    return (f && this.rows.ids.find((key) => f.matches.has(this.doc.origin(nodeOf(key))))) ?? null;
  }

  /**
   * Folds or unfolds a bullet (toggles if `folded` is omitted). On a filter's
   * path this only changes what the filter shows; otherwise it collapses the
   * bullet in the document, as an undoable command.
   */
  fold(key: RowKey, folded?: boolean, keep?: Focus): void {
    const id = nodeOf(key);
    if (this.rows.onPath(id)) {
      batch(() => {
        this.rows.foldOnPath(id, folded ?? this.rows.unfolded(key));
        this.syncRows();
        this.moveFocus(keep ?? null);
      });
    } else if (contextOf(key)) {
      // Under a mirror: folded there only, a view state, not an undo step.
      batch(() => {
        setCollapsed(this.ctx, key, folded ?? !this.rows.folded(key));
        this.syncRows();
        this.moveFocus(keep ?? null);
      });
    } else {
      const n = this.doc.get(id);
      this.run((ctx) => setCollapsed(ctx, id, folded ?? !n.collapsed), keep);
    }
  }

  /**
   * Runs a command as one transaction and one undo step, then focuses where
   * it says, or `keep`. `keep` is also where undo will put the caret. A
   * command that returns a row key moved the row there: the caret goes
   * with it. A bullet named by the command is looked for nearest to where
   * the caret was (`VisibleRows.locate`).
   */
  run(cmd: (ctx: Ctx) => Focus | RowKey | void, keep?: Focus): Op[] {
    if (this.readOnly) return [];
    let ops: Op[] = [];
    batch(() => {
      const current = this.focus();
      const before = keep ?? (current && 'caret' in current ? current : null);
      let result = undefined as Focus | RowKey | void;
      ops = this.doc.transact(() => {
        result = cmd(this.ctx);
        this.keepErased();
      });
      let target = typeof result === 'string' ? (before ? { ...before, id: result } : { id: result, caret: 0 }) : (result ?? keep);
      const near = before?.id ?? this.selection()?.head;
      const key = target && this.rows.locate(target.id, near);
      if (target && key) target = { ...target, id: key };
      this.history.record({ ops, before, after: target ?? null });
      this.moveFocus(target ?? null);
    });
    return ops;
  }

  /** Bullets erased to nothing that the command just deleted take their text along into the trash (`erased`). */
  private keepErased(): void {
    for (const [id, text] of this.erased) {
      const n = this.doc.nodes.get(id);
      if (n && this.doc.inOutline(id)) continue;
      this.erased.delete(id);
      if (n && n.text === '') setText(this.ctx, id, text);
    }
  }

  /**
   * Backspace at a bullet's start (model/commands.ts `mergeUp`). The first
   * row under the zoom's title, once gone, leaves the caret at the end of
   * the title.
   */
  mergeUp(key: RowKey, keep: Focus): void {
    const first = this.zoom() !== null && this.rows.indexOf(key) === 0;
    this.run((ctx) => mergeUp(ctx, key), keep);
    if (first && !this.doc.inOutline(nodeOf(key))) {
      this.setFocus(null);
      this.setTitleRequests((n) => n + 1);
    }
  }

  /**
   * Puts `text` at the caret, in a bullet's text or its note, in place of the
   * `back` characters before the caret (a typed command). One undo step,
   * which brings back what was replaced. The caret goes after the text, or
   * `caret` characters into it (between the brackets of `[[]]`).
   */
  insert(at: Focus, text: string, back = 0, caret = text.length): void {
    this.run((ctx) => {
      const n = ctx.doc.content(nodeOf(at.id));
      const old = at.note ? n.note : n.text;
      const start = Math.max(0, at.caret - back);
      const next = old.slice(0, start) + text + old.slice(at.caret);
      if (at.note) setNote(ctx, at.id, next);
      else setText(ctx, at.id, next);
      return { ...at, caret: start + caret };
    }, at);
  }

  /**
   * Ctrl+B / Ctrl+I: bold or italic on or off around start..end, in a
   * bullet's text or note (model/format.ts). One undo step. Returns where the
   * selection goes, inside the markers, for the editor to select again.
   */
  format(at: Omit<Focus, 'caret'>, start: number, end: number, marker: '**' | '*'): { start: number; end: number } | null {
    if (this.readOnly) return null;
    const n = this.contentOf(at.id);
    const next = toggleFormat(at.note ? n.note : n.text, start, end, marker);
    const place = (caret: number): Focus => (at.note ? { id: at.id, caret, note: true } : { id: at.id, caret });
    this.run((ctx) => {
      if (at.note) setNote(ctx, at.id, next.text);
      else setText(ctx, at.id, next.text);
      return place(next.end);
    }, place(end));
    return next;
  }

  /**
   * `((title))` completed (Suggest.tsx): the bullet becomes a mirror of
   * `target`, or a mirror goes in below it when the bullet holds other text.
   */
  makeMirror(id: RowKey, target: NodeId, start: number, end: number): void {
    this.run((ctx) => makeMirror(ctx, id, target, start, end), { id, caret: start });
  }

  /** A template taken from the `/` suggestions (model/templates.ts): what is inside it comes in, one undo step. */
  insertTemplate(id: RowKey, template: NodeId, start: number, end: number): void {
    let empty = false;
    this.run((ctx) => {
      const f = insertTemplate(ctx, id, template, start, end);
      empty = f === null;
      return f ?? { id, caret: start };
    }, { id, caret: start });
    if (empty) this.notify('В шаблоне пока ничего нет: добавьте в него пункты');
  }

  /**
   * A mirror of the bullet titled `title` in place of [start, end): the
   * first one so titled (model/links.ts `resolveLink`), or, when there is
   * none, its original made last in the structure's Inbox — one undo step,
   * the caret staying with the mirror. Returns whether a mirror was made:
   * not without such a bullet and an Inbox, nor of the bullet itself.
   */
  mirrorTitled(id: RowKey, title: string, start: number, end: number): boolean {
    const name = title.trim();
    if (!name || this.readOnly) return false;
    const target = resolveLink(this.doc, this.text, name);
    const inbox = target === null ? findInbox(this.doc) : null;
    if (target === null ? inbox === null : this.doc.origin(target) === this.doc.origin(nodeOf(id))) return false;
    this.run((ctx) => makeMirror(ctx, id, target ?? (appendTrees(ctx, inbox!, [{ text: name, children: [] }]) as Focus).id, start, end), { id, caret: start });
    return true;
  }

  /** The zoom title or its note starts or stops being edited (ZoomHeader.tsx, EditBar.tsx); leaving it settles a new title. */
  readonly editTitle = (edit: TitleEdit): void => {
    if (!edit) this.settleTitle();
    this.setTitleEdit(edit);
  };

  /**
   * Editing has moved on from a bullet whose text was typed: if its title
   * changed, links that led to it under the old one are rewritten to the new
   * one (model/commands.ts `relink`), one undo step, and a toast tells how
   * many. Not while typing: a title half typed may name another bullet.
   */
  settleTitle(): void {
    const r = this.retitled;
    this.retitled = null;
    // A `#secret` bullet is not linked to (model/tags.ts `searchable`): links naming its old title led elsewhere.
    if (!r || this.readOnly || !this.doc.has(r.id) || !searchable(this.doc, r.id)) return;
    let result = 0 as number | 'taken';
    const before = r.before;
    this.run((ctx) => {
      result = relink(ctx, this.text, r.id, before);
    }, this.keepFocus());
    const title = titleOf(this.doc.get(r.id).text);
    if (result === 'taken') this.notify(`Ссылки на «${titleOf(before)}» не изменены: «${title}» уже есть выше в документе`);
    else if (result) this.notify(`Ссылки на «${title}» обновлены в ${result} ${plural(result, 'пункте', 'пунктах', 'пунктах')}`);
  }

  /** A keystroke's worth of text: grouped with neighbouring keystrokes into one undo step. */
  type(id: RowKey, text: string): void {
    if (this.readOnly) return;
    // Erasing: the text it had before goes with the bullet, if it is then deleted (`keepErased`).
    const n = this.doc.content(nodeOf(id));
    if (this.retitled?.id !== n.id) {
      this.settleTitle();
      this.retitled = { id: n.id, before: n.text };
    }
    if (text.length < n.text.length) {
      if (!this.erased.has(n.id)) this.erased.set(n.id, n.text);
    } else if (text.length > n.text.length) this.erased.delete(n.id);
    batch(() => {
      const ops = this.doc.transact(() => setText(this.ctx, id, text));
      this.history.record({ ops, before: null, after: null }, { typing: true });
    });
  }

  /** Typing in a bullet's note: grouped into undo steps like `type`. */
  typeNote(id: RowKey, note: string): void {
    if (this.readOnly) return;
    batch(() => {
      const ops = this.doc.transact(() => setNote(this.ctx, id, note));
      this.history.record({ ops, before: null, after: null }, { typing: true });
    });
  }

  /**
   * The zoomed-in bullet whose sketch shows beside its list (view/Sketch.tsx):
   * one with lines does, unless hidden by hand; one without, once opened.
   * Reactive to the bullet's lines for whoever holds it (`nodes.acquire`).
   */
  sketchShown(): NodeId | null {
    const z = this.zoom();
    if (!z || !this.doc.has(z)) return null;
    return (this.sketchToggled().get(z) ?? this.hasSketch()) ? z : null;
  }

  /** Has the zoomed-in bullet a sketch (lines drawn), shown or not? The "Скетч" button says so. */
  hasSketch(): boolean {
    const z = this.zoom();
    if (!z || !this.doc.has(z)) return false;
    this.nodes.track(z);
    return !!this.doc.content(z).strokes?.length;
  }

  /** Opens the row's menu of actions at (x, y), px in the window. */
  openRowMenu(key: RowKey, x: number, y: number): void {
    if (this.rows.indexOf(key) >= 0) this.setRowMenu({ key, x, y });
  }

  closeRowMenu(): void {
    this.setRowMenu(null);
  }

  /** Shows or hides the zoomed-in bullet's sketch (the "Скетч" button). */
  toggleSketch(): void {
    const z = this.zoom();
    if (!z) return;
    const next = new Map(this.sketchToggled());
    next.set(z, !this.sketchShown());
    this.setSketchToggled(next);
  }

  /**
   * A change to a sketch (model/sketch.ts): one undo step that leaves the
   * caret where it is, so drawing beside a bullet being typed keeps it.
   */
  sketch(cmd: (ctx: Ctx) => void): void {
    if (this.readOnly) return;
    batch(() => {
      const ops = this.doc.transact(() => cmd(this.ctx));
      this.history.record({ ops, before: null, after: null });
    });
  }

  undo(): void {
    this.replay((doc) => this.history.undo(doc), false);
  }

  redo(): void {
    this.replay((doc) => this.history.redo(doc), true);
  }

  /**
   * Shows only matching bullets with their ancestors, or everything for an
   * empty query. Applying a search leaves editing; clearing it keeps the
   * edited row and scrolls back to it.
   */
  private applyQuery(): void {
    const query = parseQuery(this.query());
    batch(() => {
      if (isEmptyQuery(query)) {
        if (!this.filter()) return;
        this.rows.setFilter(null);
        this.setFilterSignal(null);
        const cur = this.focus();
        if (cur) this.setFocus(cur);
      } else {
        let matches = findMatches(query, this.tags, this.text, this.doc);
        const zoom = this.zoom();
        // Zoomed in: search only inside the zoomed-in bullet (under its mirrors too: their originals' insides show there), and the bullet itself.
        if (zoom) matches = new Set([...matches].filter((id) => id === zoom || this.rows.reaches(id)));
        // The zoomed-in bullet is found itself (gone up to it by the path) and nothing inside it is: all that is
        // inside shows, as below a match, rather than nothing. Found inside too (a tag in its note and its rows), the list narrows.
        const self = zoom !== null && matches.has(zoom) && matches.size === 1;
        this.rows.setFilter(self
          ? { keep: new Set([zoom]), open: new Set([zoom]), shut: new Set() }
          : { keep: keepSet(this.doc, matches, this.rows.top), open: new Set(), shut: new Set() });
        this.setFilterSignal({ query, matches, count: matches.size });
        this.setFocus(null);
      }
      this.syncRows();
    });
  }

  private replay(step: (doc: Doc) => HistoryEntry | null, forward: boolean): void {
    if (this.readOnly) return;
    batch(() => {
      const e = step(this.doc);
      if (e) this.moveFocus(focusAfter(e, forward));
    });
  }

  private syncRows(): void {
    this.setRowsVersion(this.rows.version);
  }

  /** Focuses `target` if given (its bullet's row nearest to it); otherwise drops focus if the focused row got hidden or removed. */
  private moveFocus(target: Focus | null): void {
    const key = target && this.rows.locate(target.id);
    if (target && key) return this.setFocus({ ...target, id: key });
    const cur = this.focus();
    if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
  }
}
