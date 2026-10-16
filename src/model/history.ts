import { invert, type Doc } from './doc';
import type { Focus, Op } from './types';

export interface HistoryEntry {
  ops: Op[];
  /** Caret before the change: where undo puts it. */
  before: Focus | null;
  /** Caret after the change: where redo puts it. */
  after: Focus | null;
}

const LIMIT = 1000;
/** Keystrokes closer than this extend the same undo step. */
const TYPING_PAUSE = 1000;

type SetText = Extract<Op, { t: 'setText' }>;

const singleSetText = (e: HistoryEntry): SetText | null =>
  e.ops.length === 1 && e.ops[0].t === 'setText' ? e.ops[0] : null;

/**
 * Undo/redo over op batches. Typing is grouped into one step per word:
 * keystrokes extend the open step until a pause or until a new word starts
 * after whitespace.
 */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** The typing step further keystrokes may extend. */
  private typing: { entry: HistoryEntry; time: number } | null = null;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  record(entry: HistoryEntry, opts: { typing?: boolean; now?: number } = {}): void {
    if (!entry.ops.length) return;
    this.redoStack = [];
    const now = opts.now ?? Date.now();
    const open = this.typing;
    const prev = open && singleSetText(open.entry);
    const next = singleSetText(entry);
    if (opts.typing && open && prev && next && prev.id === next.id
      && now - open.time < TYPING_PAUSE && !/\s$/.test(prev.to)) {
      open.entry.ops = [{ ...prev, to: next.to, at: next.at }];
      open.entry.after = entry.after;
      open.time = now;
      return;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.typing = opts.typing ? { entry, time: now } : null;
  }

  undo(doc: Doc): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.typing = null;
    doc.transact(() => {
      for (let i = e.ops.length - 1; i >= 0; i--) doc.apply(invert(e.ops[i]));
    });
    this.redoStack.push(e);
    return e;
  }

  redo(doc: Doc): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.typing = null;
    doc.transact(() => {
      for (const op of e.ops) doc.apply(op);
    });
    this.undoStack.push(e);
    return e;
  }
}

/** Where the caret goes after undoing (`forward` false) or redoing an entry. */
export function focusAfter(e: HistoryEntry, forward: boolean): Focus | null {
  const op = singleSetText(e);
  if (op) return { id: op.id, caret: forward ? changeEnd(op.from, op.to) : changeEnd(op.to, op.from) };
  return forward ? e.after : e.before;
}

/** End of the changed region in `next`, compared to `prev`. */
function changeEnd(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return next.length - s;
}
