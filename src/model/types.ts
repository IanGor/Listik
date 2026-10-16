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
  collapsed: boolean;
  created: number;
  updated: number;
}

/** Self-contained copy of a subtree: enough to re-insert it after removal. */
export interface NodeSnapshot {
  id: NodeId;
  order: string;
  text: string;
  collapsed: boolean;
  created: number;
  updated: number;
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
  | { t: 'setCollapsed'; id: NodeId; from: boolean; to: boolean };

/** Where the caret should go after a command. */
export interface Focus {
  id: NodeId;
  caret: number;
}
