import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import { collapseChildren, cycleTask, setCollapsed, setNote, setText, toggleDone, untask, type Ctx, makeMirror } from '../model/commands';
import type { Doc } from '../model/doc';
import { toggleFormat } from '../model/format';
import { History, focusAfter, type HistoryEntry } from '../model/history';
import { resolveLink } from '../model/links';
import { VisibleRows, keepSet, nodeOf, type RowKey } from '../model/rows';
import { TextIndex, findMatches, isEmptyQuery, parseQuery, type Query } from '../model/search';
import { TagIndex, tagText } from '../model/tags';
import type { Focus, NodeId } from '../model/types';
import type { Backup } from '../persist/backup';
import type { Persistence } from '../persist/idb';
import type { SyncStatus } from '../sync/engine';
import type { Opened, SyncHandle } from '../sync/setup';
import { NodeSignals } from './node-signals';
import { touch } from './screen';

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
  /** Completed bullets are shown (Ctrl+O hides them); remembered per browser. */
  readonly showDone: Accessor<boolean>;
  private setShowDone: Setter<boolean>;
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
  /** Bumped to open the sync dialog. */
  readonly syncRequests: Accessor<number>;
  private setSyncRequests: Setter<number>;
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
    [this.homeRequests, this.setHomeRequests] = createSignal(0);
    [this.helpRequests, this.setHelpRequests] = createSignal(0);
    [this.syncRequests, this.setSyncRequests] = createSignal(0);
    [this.syncStatus, this.setSyncStatus] = createSignal<SyncStatus>({ phase: 'stopped', pending: 0, head: 0 });
    [this.toast, this.setToast] = createSignal<string | null>(null);
    [this.selection, this.setSelectionSignal] = createSignal<Selection | null>(null);
    [this.dragged, this.setDragged] = createSignal<ReadonlySet<RowKey>>(new Set());
    const hideDone = readSetting(HIDE_DONE) === '1';
    [this.showDone, this.setShowDone] = createSignal(!hideDone);
    if (hideDone) this.rows.setHideDone(true);
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

  /** Is the row a mirror's own (its heading takes no edits: model/commands.ts)? */
  isMirror(key: RowKey): boolean {
    return !!this.doc.nodes.get(nodeOf(key))?.mirrorOf;
  }

  /** An edit was tried on a mirror's heading: say where it can be made, and how the mirror goes. */
  mirrorReadOnly(): void {
    this.notify(touch()
      ? 'Заголовок зеркала правится в оригинале — коснитесь ромбика'
      : 'Заголовок зеркала правится в оригинале (клик по ромбику); удалить зеркало — Backspace в начале строки');
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

  /** A click on a tag: search for it. */
  filterByTag(tag: string): void {
    this.setQuery(tagText(tag), true);
  }

  /**
   * A click on a `[[link]]`: zoom into the bullet it names, where it really
   * is in the outline (model/links.ts). A search is cleared, so all of it shows.
   */
  followLink(title: string): void {
    const id = resolveLink(this.doc, this.text, title);
    if (!id) return this.notify(`Нет пункта «${title.trim()}»`);
    batch(() => {
      this.setQuery('', true);
      this.setFocus(null);
      this.zoomTo(id);
    });
  }

  /**
   * Zoom into a bullet: it becomes the title, its children the top level.
   * A search in progress is cleared: you went to a place found, so it shows
   * whole (a search started inside a zoom covers only that bullet).
   */
  zoomTo(key: RowKey | null): void {
    let id = key && nodeOf(key);
    // A mirror has no inside of its own: zooming into it leads to the original (model/mirrors.ts).
    if (id && this.doc.has(id)) id = this.doc.origin(id);
    const target = id && id !== this.doc.root && this.doc.has(id) ? id : null;
    if (target === this.zoom()) return;
    batch(() => {
      // The new top first: under the filter that rebuild lists only the paths, and the clear then lists the place.
      this.rows.setTop(target ?? this.doc.root);
      this.setZoomSignal(target);
      if (this.query() || this.filter()) this.setQuery('', true);
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
    this.notify(show ? 'Выполненные показаны' : `Выполненные скрыты — ${touch() ? 'показать можно в меню «⋯»' : 'Ctrl+O, чтобы показать'}`);
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

  /**
   * Applies a change to tasks. When completed tasks are hidden, completing
   * one takes it out of the list, and the caret moves on to the row that
   * took its place.
   */
  private changeTasks(cmd: (ctx: Ctx) => void, ids: RowKey[], keep?: Focus): void {
    if (!ids.length) return;
    const first = this.rows.indexOf(ids[0]);
    const last = this.rows.indexOf(ids[ids.length - 1]);
    const end = last >= 0 ? this.rows.subtreeEnd(last) : -1;
    const next = (end >= 0 ? this.rows.ids[end] : undefined) ?? (first > 0 ? this.rows.ids[first - 1] : undefined);
    batch(() => {
      this.run(cmd, keep);
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
      return;
    }
    this.setSyncStatus(engine.status);
    this.unwatchSync = engine.subscribe((s) => this.setSyncStatus({ ...s }));
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
   * which brings back what was replaced.
   */
  insert(at: Focus, text: string, back = 0): void {
    if (this.isMirror(at.id)) return this.mirrorReadOnly();
    this.run((ctx) => {
      const n = ctx.doc.content(nodeOf(at.id));
      const old = at.note ? n.note : n.text;
      const start = Math.max(0, at.caret - back);
      const next = old.slice(0, start) + text + old.slice(at.caret);
      if (at.note) setNote(ctx, at.id, next);
      else setText(ctx, at.id, next);
      return { ...at, caret: start + text.length };
    }, at);
  }

  /**
   * Ctrl+B / Ctrl+I: bold or italic on or off around start..end, in a
   * bullet's text or note (model/format.ts). One undo step. Returns where the
   * selection goes, inside the markers, for the editor to select again.
   */
  format(at: Omit<Focus, 'caret'>, start: number, end: number, marker: '**' | '*'): { start: number; end: number } | null {
    if (this.readOnly) return null;
    if (this.isMirror(at.id)) {
      this.mirrorReadOnly();
      return null;
    }
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
