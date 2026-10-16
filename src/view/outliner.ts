import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import type { Ctx } from '../model/commands';
import type { Doc } from '../model/doc';
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
   * Runs a command as one transaction, then focuses where it says, or `keep`.
   * If the focused row got hidden (e.g. its parent collapsed), focus is dropped.
   */
  run(cmd: (ctx: Ctx) => Focus | void, keep?: Focus): void {
    batch(() => {
      let target = undefined as Focus | void;
      this.doc.transact(() => {
        target = cmd(this.ctx);
      });
      target ??= keep;
      if (target) this.setFocus(target);
      else {
        const cur = this.focus();
        if (cur && this.rows.indexOf(cur.id) < 0) this.setFocus(null);
      }
    });
  }
}
