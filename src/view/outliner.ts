import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import { setCollapsed, setText, type Ctx } from '../model/commands';
import type { Doc } from '../model/doc';
import { History, focusAfter, type HistoryEntry } from '../model/history';
import { VisibleRows, keepSet } from '../model/rows';
import { TagIndex } from '../model/tags';
import type { Focus, NodeId } from '../model/types';
import { NodeSignals } from './node-signals';

/** Where the caret goes: a text offset, or a horizontal position on the row's first/last line (↑/↓). */
export type FocusRequest = Focus | { id: NodeId; x: number; line: 'first' | 'last' };

export interface TagFilter {
  tag: string;
  /** Bullets carrying the tag when the filter was applied. */
  count: number;
}

/** Glue between the model and the view: the doc, its derived state and the reactive handles the UI reads. */
export class Outliner {
  readonly doc: Doc;
  readonly rows: VisibleRows;
  readonly tags: TagIndex;
  readonly ctx: Ctx;
  readonly history = new History();
  readonly nodes = new NodeSignals();
  /** Changes whenever the visible rows change. */
  readonly rowsVersion: Accessor<number>;
  /** The row being edited; null when nothing is. A new object on every request, even for the same row. */
  readonly focus: Accessor<FocusRequest | null>;
  readonly filter: Accessor<TagFilter | null>;
  private setRowsVersion: Setter<number>;
  private setFocusSignal: Setter<FocusRequest | null>;
  private setFilterSignal: Setter<TagFilter | null>;

  constructor(doc: Doc) {
    this.doc = doc;
    this.rows = new VisibleRows(doc);
    this.tags = new TagIndex(doc);
    this.ctx = { doc, rows: this.rows };
    [this.rowsVersion, this.setRowsVersion] = createSignal(this.rows.version);
    [this.focus, this.setFocusSignal] = createSignal<FocusRequest | null>(null, { equals: false });
    [this.filter, this.setFilterSignal] = createSignal<TagFilter | null>(null);
    doc.subscribe(this.nodes);
    doc.subscribe({ commit: () => this.syncRows() });
  }

  setFocus(f: FocusRequest | null): void {
    this.setFocusSignal(f);
  }

  /**
   * Shows only bullets tagged `tag`, with their ancestors; null shows
   * everything again. Cost depends on the number of matches, not on the
   * size of the document. Applying a filter leaves editing; clearing it
   * keeps the edited row and scrolls back to it.
   */
  filterByTag(tag: string | null): void {
    batch(() => {
      if (tag) {
        const matches = this.tags.nodesWith(tag);
        this.rows.setFilter({ keep: keepSet(this.doc, matches), open: new Set() });
        this.setFilterSignal({ tag: tag.toLowerCase(), count: matches.size });
        this.setFocus(null);
      } else {
        this.rows.setFilter(null);
        this.setFilterSignal(null);
        const cur = this.focus();
        if (cur) this.setFocus(cur);
      }
      this.syncRows();
    });
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
    batch(() => {
      const ops = this.doc.transact(() => setText(this.ctx, id, text));
      this.history.record({ ops, before: null, after: null }, { typing: true });
    });
  }

  undo(): void {
    this.replay((doc) => this.history.undo(doc), false);
  }

  redo(): void {
    this.replay((doc) => this.history.redo(doc), true);
  }

  private replay(step: (doc: Doc) => HistoryEntry | null, forward: boolean): void {
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
