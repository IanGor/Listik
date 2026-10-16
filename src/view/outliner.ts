import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import { collapseChildren, setCollapsed, setNote, setText, toggleDone, type Ctx } from '../model/commands';
import type { Doc } from '../model/doc';
import { History, focusAfter, type HistoryEntry } from '../model/history';
import { VisibleRows, keepSet } from '../model/rows';
import { TextIndex, findMatches, isEmptyQuery, parseQuery, type Query } from '../model/search';
import { TagIndex } from '../model/tags';
import type { Focus, NodeId } from '../model/types';
import type { Backup } from '../persist/backup';
import { NodeSignals } from './node-signals';

const HIDE_DONE = 'listik-hide-done';

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

/** Where the caret goes: a text offset, or a horizontal position on the row's first/last line (↑/↓). */
export type FocusRequest = Focus | { id: NodeId; x: number; line: 'first' | 'last'; note?: true };

/** Several bullets selected: from `anchor` (where it started) to `head` (the moving end). */
export interface Selection {
  anchor: NodeId;
  head: NodeId;
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
  /** Bumped to open the keyboard shortcuts panel. */
  readonly helpRequests: Accessor<number>;
  private setHelpRequests: Setter<number>;
  /** Bumped by `goHome`: the view scrolls back to the top. */
  readonly homeRequests: Accessor<number>;
  /** A short message at the bottom of the screen (import results, errors). */
  readonly toast: Accessor<string | null>;
  readonly selection: Accessor<Selection | null>;
  /** Completed bullets are shown (Ctrl+O hides them); remembered per browser. */
  readonly showDone: Accessor<boolean>;
  private setShowDone: Setter<boolean>;
  /** Rows being dragged (with their subtrees), shown dimmed. */
  readonly dragged: Accessor<ReadonlySet<NodeId>>;
  readonly setDragged: Setter<ReadonlySet<NodeId>>;
  /** Automatic copies into a folder; null for in-memory documents. */
  backup: Backup | null = null;
  /** Another tab holds the document: nothing here may change it. */
  readonly readOnly: boolean;
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
  private selectionCache: { selection: Selection; version: number; set: Set<NodeId>; roots: NodeId[] } | null = null;
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
    [this.homeRequests, this.setHomeRequests] = createSignal(0);
    [this.helpRequests, this.setHelpRequests] = createSignal(0);
    [this.toast, this.setToast] = createSignal<string | null>(null);
    [this.selection, this.setSelectionSignal] = createSignal<Selection | null>(null);
    [this.dragged, this.setDragged] = createSignal<ReadonlySet<NodeId>>(new Set());
    const hideDone = readSetting(HIDE_DONE) === '1';
    [this.showDone, this.setShowDone] = createSignal(!hideDone);
    if (hideDone) this.rows.setHideDone(true);
    doc.subscribe(this.nodes);
    doc.subscribe({
      commit: () => {
        // The zoomed-in bullet was deleted (or its creation undone): back to the whole outline.
        const z = this.zoom();
        if (z && !doc.has(z)) this.zoomTo(null);
        this.syncRows();
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
  selectedSet(): ReadonlySet<NodeId> {
    return this.selectionInfo().set;
  }

  /** Selected bullets not inside another selected one, in order: what block commands act on. */
  selectionRoots(): NodeId[] {
    return this.selectionInfo().roots;
  }

  private selectionInfo(): { set: Set<NodeId>; roots: NodeId[] } {
    const selection = this.selection();
    const version = this.rowsVersion();
    if (!selection) return { set: new Set(), roots: [] };
    const cache = this.selectionCache;
    if (cache && cache.selection === selection && cache.version === version) return cache;
    const a = this.rows.indexOf(selection.anchor);
    const h = this.rows.indexOf(selection.head);
    const set = new Set<NodeId>();
    const roots: NodeId[] = [];
    if (a >= 0 && h >= 0) {
      const start = Math.min(a, h);
      let end = Math.max(a, h) + 1;
      for (let i = start; i < end; i++) {
        end = Math.max(end, this.rows.subtreeEnd(i));
        const id = this.rows.ids[i];
        set.add(id);
        if (!set.has(this.doc.get(id).parent!)) roots.push(id);
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

  /** A click on a tag: search for it. */
  filterByTag(tag: string): void {
    this.setQuery(`#${tag}`, true);
  }

  /**
   * Zoom into a bullet: it becomes the title, its children the top level.
   * A search in progress is re-run within the new scope.
   */
  zoomTo(id: NodeId | null): void {
    const target = id && id !== this.doc.root && this.doc.has(id) ? id : null;
    if (target === this.zoom()) return;
    batch(() => {
      this.rows.setTop(target ?? this.doc.root);
      this.setZoomSignal(target);
      if (this.filter()) this.applyQuery();
      this.syncRows();
      const cur = this.focus();
      if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
    });
  }

  /**
   * The logo: back to the top of the whole outline with every top-level
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

  /** Alt+→: zoom into a bullet and edit its first child, or its title if it has none. */
  zoomIn(id: NodeId): void {
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

  /** Ctrl+O: hides completed bullets, or shows them again. */
  toggleShowDone(): void {
    const show = !this.showDone();
    batch(() => {
      this.rows.setHideDone(!show);
      this.setShowDone(show);
      writeSetting(HIDE_DONE, show ? null : '1');
      this.syncRows();
      const cur = this.focus();
      if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
    });
    this.notify(show ? 'Выполненные показаны' : 'Выполненные скрыты — Ctrl+O, чтобы показать');
  }

  /**
   * Ctrl+Enter: completes the bullets, or un-completes them. When completed
   * bullets are hidden they leave the list, and the caret moves on to the
   * row that took their place.
   */
  toggleDone(ids: NodeId[], keep?: Focus): void {
    if (!ids.length) return;
    const first = this.rows.indexOf(ids[0]);
    const last = this.rows.indexOf(ids[ids.length - 1]);
    const end = last >= 0 ? this.rows.subtreeEnd(last) : -1;
    const next = (end >= 0 ? this.rows.ids[end] : undefined) ?? (first > 0 ? this.rows.ids[first - 1] : undefined);
    batch(() => {
      this.run((ctx) => toggleDone(ctx, ids), keep);
      if (keep && this.rows.indexOf(keep.id) < 0 && next) this.setFocus({ id: next, caret: 0 });
      if (this.selection() && !this.selectedSet().size) this.select(null);
    });
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

  /** Ctrl+F: put the caret into the search box. */
  requestSearch(): void {
    this.setSearchRequests((n) => n + 1);
  }

  /** The first visible row that matches the search. */
  firstMatch(): NodeId | null {
    const f = this.filter();
    return (f && this.rows.ids.find((id) => f.matches.has(id))) ?? null;
  }

  /**
   * Folds or unfolds a bullet (toggles if `folded` is omitted). On a filter's
   * path this only changes what the filter shows; otherwise it collapses the
   * bullet in the document, as an undoable command.
   */
  fold(id: NodeId, folded?: boolean, keep?: Focus): void {
    if (this.rows.onPath(id)) {
      batch(() => {
        this.rows.setOpen(id, folded === undefined ? !this.rows.isOpen(id) : !folded);
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
   * it says, or `keep`. `keep` is also where undo will put the caret.
   */
  run(cmd: (ctx: Ctx) => Focus | void, keep?: Focus): void {
    if (this.readOnly) return;
    batch(() => {
      const current = this.focus();
      const before = keep ?? (current && 'caret' in current ? current : null);
      let target = undefined as Focus | void;
      const ops = this.doc.transact(() => {
        target = cmd(this.ctx);
      });
      target ??= keep;
      this.history.record({ ops, before, after: target ?? null });
      this.moveFocus(target ?? null);
    });
  }

  /** A keystroke's worth of text: grouped with neighbouring keystrokes into one undo step. */
  type(id: NodeId, text: string): void {
    if (this.readOnly) return;
    batch(() => {
      const ops = this.doc.transact(() => setText(this.ctx, id, text));
      this.history.record({ ops, before: null, after: null }, { typing: true });
    });
  }

  /** Typing in a bullet's note: grouped into undo steps like `type`. */
  typeNote(id: NodeId, note: string): void {
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

  /** Focuses `target` if given; otherwise drops focus if the focused row got hidden or removed. */
  private moveFocus(target: Focus | null): void {
    if (target && this.rows.indexOf(target.id) >= 0) return this.setFocus(target);
    const cur = this.focus();
    if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
  }
}
