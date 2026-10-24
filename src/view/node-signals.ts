import { batch, createSignal, type Setter } from 'solid-js';
import type { DocListener } from '../model/doc';
import type { NodeId, Op } from '../model/types';

interface Entry {
  read: () => number;
  write: Setter<number>;
  /** Components holding this node (rows, the zoom title, breadcrumbs). */
  refs: number;
}

/**
 * Per-node change signals, kept only for nodes on screen, so an edit
 * re-renders just what shows that node. Components `acquire` a node while
 * mounted and `release` it on cleanup. Changes made during a transaction
 * fire together on commit, when the doc is consistent again.
 */
export class NodeSignals implements DocListener {
  private signals = new Map<NodeId, Entry>();
  private dirty = new Set<NodeId>();

  acquire(id: NodeId): void {
    this.entry(id).refs++;
  }

  release(id: NodeId): void {
    const e = this.signals.get(id);
    if (e && --e.refs <= 0) this.signals.delete(id);
  }

  /** Subscribes the current computation to changes of `id`. */
  track(id: NodeId): void {
    this.entry(id).read();
  }

  op(op: Op): void {
    switch (op.t) {
      case 'setText':
      case 'setNote':
      case 'setDone':
      case 'setTodo':
      case 'setCollapsed':
      case 'setMirror':
      case 'addStrokes':
      case 'removeStrokes':
        this.dirty.add(op.id);
        break;
      case 'insert':
      case 'remove':
        this.dirty.add(op.parent);
        break;
      case 'move':
        this.dirty.add(op.from.parent);
        this.dirty.add(op.to.parent);
        break;
    }
  }

  commit(): void {
    if (!this.dirty.size) return;
    batch(() => {
      for (const id of this.dirty) this.signals.get(id)?.write((v) => v + 1);
    });
    this.dirty.clear();
  }

  private entry(id: NodeId): Entry {
    let e = this.signals.get(id);
    if (!e) {
      const [read, write] = createSignal(0);
      e = { read, write, refs: 0 };
      this.signals.set(id, e);
    }
    return e;
  }
}
