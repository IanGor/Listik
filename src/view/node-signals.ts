import { batch, createSignal, type Setter } from 'solid-js';
import type { DocListener } from '../model/doc';
import type { NodeId, Op } from '../model/types';

/**
 * Per-node change signals, created only for mounted rows, so an edit
 * re-renders just the rows it touches. Changes made during a transaction
 * fire together on commit, when the doc is consistent again.
 */
export class NodeSignals implements DocListener {
  private signals = new Map<NodeId, { read: () => number; write: Setter<number> }>();
  private dirty = new Set<NodeId>();

  /** Subscribes the current computation to changes of `id`. */
  track(id: NodeId): void {
    let s = this.signals.get(id);
    if (!s) {
      const [read, write] = createSignal(0);
      s = { read, write };
      this.signals.set(id, s);
    }
    s.read();
  }

  release(id: NodeId): void {
    this.signals.delete(id);
  }

  op(op: Op): void {
    switch (op.t) {
      case 'setText':
      case 'setCollapsed':
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
}
