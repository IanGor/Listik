import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import { setText, type Ctx } from '../model/commands';
import type { Doc } from '../model/doc';
import { History, focusAfter, type HistoryEntry } from '../model/history';
import { VisibleRows } from '../model/rows';
import type { Focus, NodeId } from '../model/types';
import { NodeSignals } from './node-signals';

/** Where the caret goes: a text offset, or a horizontal position on the row's first/last line (↑/↓). */
export type FocusRequest = Focus | { id: NodeId; x: number; line: 'first' | 'last' };

/** Glue between the model and the view: the doc, its derived state and the reactive handles the UI reads. */
export class Outliner {
  readonly doc: Doc;
  readonly rows: VisibleRows;
  readonly ctx: Ctx;
  readonly history = new History();
  readonly nodes = new NodeSignals();
  /** Changes whenever the visible rows change. */
  readonly rowsVersion: Accessor<number>;
  /** The row being edited; null when nothing is. A new object on every request, even for the same row. */
  readonly focus: Accessor<FocusRequest | null>;
  private setRowsVersion: Setter<number>;
  private setFocusSignal: Setter<FocusRequest | null>;

  constructor(doc: Doc) {
    this.doc = doc;
    this.rows = new VisibleRows(doc);
    this.ctx = { doc, rows: this.rows };
    [this.rowsVersion, this.setRowsVersion] = createSignal(this.rows.version);
    [this.focus, this.setFocusSignal] = createSignal<FocusRequest | null>(null, { equals: false });
    doc.subscribe(this.nodes);
    doc.subscribe({ commit: () => this.setRowsVersion(this.rows.version) });
  }

  setFocus(f: FocusRequest | null): void {
    this.setFocusSignal(f);
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

  /** Focuses `target` if given; otherwise drops focus if the focused row got hidden or removed. */
  private moveFocus(target: Focus | null): void {
    if (target && this.rows.indexOf(target.id) >= 0) return this.setFocus(target);
    const cur = this.focus();
    if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
  }
}
