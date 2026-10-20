import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import {
  addYear, createStructure, dayOf, fillDay, findInbox, findPeriod, hasStructure, neighbour, periodAt, periodName, quarterPeriod, type Period,
} from '../model/calendar';
import { appendTrees, collapseChildren, cycleTask, deleteNode, setCollapsed, setNote, setText, toggleDone, untask, type Ctx, makeMirror } from '../model/commands';
import type { Doc } from '../model/doc';
import { toggleFormat } from '../model/format';
import { History, focusAfter, type HistoryEntry } from '../model/history';
import { linkEnd, resolveLink } from '../model/links';
import { VisibleRows, contextOf, keepSet, nodeOf, type RowKey } from '../model/rows';
import { TextIndex, findMatches, isEmptyQuery, parseQuery, type Query } from '../model/search';
import { TagIndex, tagText } from '../model/tags';
import type { Focus, NodeId } from '../model/types';
import type { Backup } from '../persist/backup';
import type { Persistence } from '../persist/idb';
import type { SyncStatus } from '../sync/engine';
import type { Opened, SyncHandle } from '../sync/setup';
import { NodeSignals } from './node-signals';

/** Saved searches (the star in the search box), newest first; per browser, like the theme. */
const SAVED_SEARCHES = 'listik-saved-searches';
/** Saved searches kept at most: saving one more lets the oldest go. */
export const SAVED_MAX = 20;

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
  readonly editTitle: Setter<TitleEdit>;
  /** Bumped to open the keyboard shortcuts panel. */
  readonly helpRequests: Accessor<number>;
  private setHelpRequests: Setter<number>;
  /** Bumped by `goHome`: the view scrolls back to the top. */
  readonly homeRequests: Accessor<number>;
  /** A short message at the bottom of the screen (import results, errors). */
  readonly toast: Accessor<string | null>;
  readonly selection: Accessor<Selection | null>;
  /** Saved searches, newest first (SearchBar.tsx): the star saves what is typed, focus lists them. */
  readonly savedSearches: Accessor<string[]>;
  private setSavedSearches: Setter<string[]>;
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
  /** The day `goToday` went into, and on what date: the next morning it leads on to the new day. */
  private today: { day: NodeId; date: string } | null = null;
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
  private pendingSearch: number | null = null;

  constructor(doc: Doc, options: { readOnly?: boolean } = {}) {
    this.doc = doc;
    this.readOnly = options.readOnly ?? false;
    this.rows = new VisibleRows(doc);
    this.tags = new TagIndex(doc);
    this.text = new TextIndex(doc);
    this.ctx = { doc, rows: this.rows };
    [this.rowsVersion, this.setRowsVersion] = createSignal(this.rows.version);
    [this.focus, this.setFocusSignal] = createSignal<FocusRequest | null>(null, { equals: false });
    [this.query, this.setQuerySignal] = createSignal('');
    [this.filter, this.setFilterSignal] = createSignal<SearchFilter | null>(null);
    [this.searchRequests, this.setSearchRequests] = createSignal(0);
    [this.zoom, this.setZoomSignal] = createSignal<NodeId | null>(null);
    [this.titleRequests, this.setTitleRequests] = createSignal(0);
    [this.titleEdit, this.editTitle] = createSignal<TitleEdit>(null);
    [this.cameFrom, this.setCameFrom] = createSignal<{ to: NodeId; from: NodeId } | null>(null);
    [this.homeRequests, this.setHomeRequests] = createSignal(0);
    [this.helpRequests, this.setHelpRequests] = createSignal(0);
    [this.syncRequests, this.setSyncRequests] = createSignal(0);
    [this.syncStatus, this.setSyncStatus] = createSignal<SyncStatus>({ phase: 'stopped', pending: 0, head: 0 });
    [this.toast, this.setToast] = createSignal<string | null>(null);
    [this.selection, this.setSelectionSignal] = createSignal<Selection | null>(null);
    [this.dragged, this.setDragged] = createSignal<ReadonlySet<RowKey>>(new Set());
    [this.savedSearches, this.setSavedSearches] = createSignal(readSaved());
    // Completed bullets are no longer hidden (that setting is gone): forget it.
    writeSetting('listik-hide-done', null);
    doc.subscribe(this.nodes);
    doc.subscribe({
      commit: () => {
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
    batch(() => {
      if (f && this.selection()) this.setSelectionSignal(null);
      this.setFocusSignal(f);
    });
  }

  /** Selects rows from `anchor` to `head` (null clears); leaves editing. */
  select(selection: Selection | null): void {
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
   * over the new place, so its results show level after level.
   */
  zoomTo(key: RowKey | null, keepSearch = false): void {
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
      this.syncRows();
      const cur = this.focus();
      if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
    });
    if (target) this.enterDay(target);
  }

  /**
   * A day of the calendar entered for the first time, by any way: its
   * template goes in (model/calendar.ts `fillDay`, one undo step), the caret
   * stays out. With sync, only once the server has been heard from, and
   * only if the day is still where the user is.
   */
  private enterDay(id: NodeId): void {
    if (this.readOnly || this.doc.get(id).children.length || periodAt(this.doc, id)?.kind !== 'day') return;
    const fill = () => {
      if (this.zoom() === id && this.doc.has(id)) this.run((ctx) => void fillDay(ctx, id), this.keepFocus());
    };
    if (this.syncing() && !this.synced) this.afterSync.push(fill);
    else fill();
  }

  /** The caret where it is, for a command that should not move it. */
  private keepFocus(): Focus | undefined {
    const f = this.focus();
    return f && 'caret' in f ? f : undefined;
  }

  /**
   * Makes sure the calendar has the period's year (model/calendar.ts
   * `addYear`, one undo step), and finds the period. With sync, a missing
   * year waits for the server: null then.
   */
  private periodBullet(p: Period): NodeId | null {
    const found = findPeriod(this.doc, this.tags, p);
    if (found !== null || this.readOnly || findPeriod(this.doc, this.tags, quarterPeriod(p)) !== null) return found;
    if (this.syncing() && !this.synced) return null;
    this.run((ctx) => void addYear(ctx, this.tags, p.y), this.keepFocus());
    return findPeriod(this.doc, this.tags, p);
  }

  /**
   * The logo, and the start: into today's day in the calendar
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

  /** The calendar period (quarter of a year, month, week, day) the zoom is in; null outside the calendar. Reactive. */
  zoomPeriod(): Period | null {
    this.rowsVersion();
    const z = this.zoom();
    return z && this.doc.has(z) ? periodAt(this.doc, z) : null;
  }

  /**
   * ‹ › over the list, Ctrl+Alt+←/→: into the period before or after the one
   * zoomed into, across years (model/calendar.ts `neighbour`). A year not
   * yet in the calendar comes in; periods missing from it otherwise are
   * passed over. Returns whether the zoom is in a period at all.
   */
  stepPeriod(step: -1 | 1): boolean {
    let p = this.zoomPeriod();
    if (!p) return false;
    for (let i = 0; i < 400; i++) {
      p = neighbour(p, step);
      const id = this.periodBullet(p);
      if (id === null) {
        if (this.syncing() && !this.synced) {
          this.notify('Ждём ответа сервера синхронизации');
          return true;
        }
        continue;
      }
      batch(() => {
        this.setFocus(null);
        this.zoomTo(id);
      });
      return true;
    }
    return true;
  }

  /** The app comes back into view: still in yesterday's day, it goes on to today's. */
  resumed(): void {
    const t = this.today;
    if (t && t.date !== new Date().toDateString() && this.zoom() === t.day) this.goToday(true);
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
      this.run((ctx) => collapseChildren(ctx, this.doc.root));
      this.setFocus(null);
      this.setHomeRequests((n) => n + 1);
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
   * structure (`bare` aside): the structure goes in. At the start it takes
   * the place of the lone empty bullet, and is no undo step: there was
   * nothing before it.
   */
  firstStructure(start: boolean): void {
    if (this.readOnly || this.bare || this.structure()) return;
    if (!start) return this.run((ctx) => void createStructure(ctx, new Date().getFullYear()), this.keepFocus());
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
   * A press on a bullet that did not drag: a task's checkbox toggles; a plain
   * bullet zooms in.
   */
  pressBullet(id: RowKey): void {
    if (!this.contentOf(id).todo) return this.zoomTo(id);
    const cur = this.focus();
    this.toggleDone([id], cur && 'caret' in cur ? cur : undefined);
  }

  /** Applies a change to tasks: completed ones stay where they are, struck through. */
  private changeTasks(cmd: (ctx: Ctx) => void, ids: RowKey[], keep?: Focus): void {
    if (ids.length) this.run(cmd, keep);
  }

  /** Shows a message for a few seconds. */
  notify(message: string): void {
    this.setToast(message);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.setToast(null), 4000);
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

  /** The first visible row that matches the search. */
  firstMatch(): RowKey | null {
    const f = this.filter();
    return (f && this.rows.ids.find((key) => f.matches.has(nodeOf(key)))) ?? null;
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
        this.rows.setOpen(id, folded === undefined ? !this.rows.isOpen(id) : !folded);
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
  run(cmd: (ctx: Ctx) => Focus | RowKey | void, keep?: Focus): void {
    if (this.readOnly) return;
    batch(() => {
      const current = this.focus();
      const before = keep ?? (current && 'caret' in current ? current : null);
      let result = undefined as Focus | RowKey | void;
      const ops = this.doc.transact(() => {
        result = cmd(this.ctx);
      });
      let target = typeof result === 'string' ? (before ? { ...before, id: result } : { id: result, caret: 0 }) : (result ?? keep);
      const near = before?.id ?? this.selection()?.head;
      const key = target && this.rows.locate(target.id, near);
      if (target && key) target = { ...target, id: key };
      this.history.record({ ops, before, after: target ?? null });
      this.moveFocus(target ?? null);
    });
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

  /** A keystroke's worth of text: grouped with neighbouring keystrokes into one undo step. */
  type(id: RowKey, text: string): void {
    if (this.readOnly) return;
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
        // Zoomed in: search only inside the zoomed-in bullet.
        if (this.zoom()) matches = new Set([...matches].filter((id) => this.rows.contains(id)));
        this.rows.setFilter({ keep: keepSet(this.doc, matches, this.rows.top), open: new Set() });
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
