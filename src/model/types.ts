export type NodeId = string;

export interface OutlineNode {
  id: NodeId;
  /** null only for the invisible root. */
  parent: NodeId | null;
  /** Sorted by `order`, ascending. */
  children: NodeId[];
  /** Fractional index among siblings. */
  order: string;
  text: string;
  /** A note under the bullet (Shift+Enter), may span lines; '' for none. */
  note: string;
  collapsed: boolean;
  /** A task (Ctrl+L): drawn as a checkbox. Plain bullets are just text. */
  todo: boolean;
  /** A completed task: checked and struck through. Only tasks are ever done. */
  done: boolean;
  created: number;
  updated: number;
  /**
   * A mirror (typed as `((title))`): this bullet shows and edits the text,
   * note and task state of the bullet `mirrorOf`, wherever it stands. Its
   * own text, note and flags are unused; it never has children of its own.
   */
  mirrorOf: NodeId | null;
}

/** Self-contained copy of a subtree: enough to re-insert it after removal. */
export interface NodeSnapshot {
  id: NodeId;
  order: string;
  text: string;
  note: string;
  collapsed: boolean;
  todo: boolean;
  done: boolean;
  created: number;
  updated: number;
  mirrorOf?: NodeId;
  children: NodeSnapshot[];
}

export interface Position {
  parent: NodeId;
  order: string;
}

/**
 * The only way to change a Doc. Every op carries enough data to be inverted
 * without looking at the document (see `invert`).
 */
export type Op =
  | { t: 'insert'; parent: NodeId; node: NodeSnapshot }
  | { t: 'remove'; parent: NodeId; node: NodeSnapshot }
  /** `at`: edit time, so replaying the op log reproduces `updated`. */
  | { t: 'setText'; id: NodeId; from: string; to: string; at?: number }
  | { t: 'move'; id: NodeId; from: Position; to: Position }
  | { t: 'setCollapsed'; id: NodeId; from: boolean; to: boolean }
  | { t: 'setTodo'; id: NodeId; from: boolean; to: boolean }
  | { t: 'setDone'; id: NodeId; from: boolean; to: boolean }
  /** `at`: edit time, as for setText. */
  | { t: 'setNote'; id: NodeId; from: string; to: string; at?: number }
  /** Makes the bullet a mirror of `to` (or a plain bullet again with null). */
  | { t: 'setMirror'; id: NodeId; from: NodeId | null; to: NodeId | null };

/** Where the caret should go after a command. */
export interface Focus {
  id: NodeId;
  caret: number;
  /** In the bullet's note rather than its text. */
  note?: true;
}
