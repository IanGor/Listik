import type { RowKey } from '../model/rows';
import type { NodeId } from '../model/types';
import { Outliner } from './outliner';

/**
 * The tree panel's outliner (TreePanel.tsx): the whole document once more,
 * from the top, beside the outline. It shares the doc, its indexes, node
 * signals and the one history of edits with the outline's, and edits as it
 * does (text, Enter, Tab, Backspace, dragging); its rows fold their own way
 * (`VisibleRows` detached), never touching the outline's folds, and its
 * caret is its own, so the outline keeps its place.
 *
 * It never zooms: a bullet's dot opens it in the outline instead, and the
 * panel marks the outline's place (`current`) and follows it (`follow`).
 * Messages, help and search are the outline's.
 */
export class TreeOutliner extends Outliner {
  readonly main: Outliner;
  /** After a bullet was opened in the outline: the phone's drawer closes. */
  onOpen: (() => void) | null = null;

  constructor(main: Outliner) {
    super(main.doc, { shared: main });
    this.main = main;
  }

  current(): NodeId | null {
    return this.main.zoom();
  }

  zoomTo(key: RowKey | null): void {
    if (key === null) return;
    this.main.zoomTo(key);
    this.onOpen?.();
  }

  zoomIn(id: RowKey): void {
    this.zoomTo(id);
  }

  zoomOut(): void {}

  followLink(title: string): void {
    this.main.followLink(title);
    this.onOpen?.();
  }

  notify(message: string): void {
    this.main.notify(message);
  }

  showHelp(): void {
    this.main.showHelp();
  }

  requestSearch(): void {
    this.main.requestSearch();
  }

  /** The outline went to `id`: the way to it unfolds here, and its row scrolls into view, not edited. */
  follow(id: NodeId | null): void {
    if (id === null || !this.doc.has(id)) return;
    this.rows.reveal(id);
    this.syncRows();
    const key = this.rows.locate(id);
    if (key) this.setRevealRequests(key);
  }
}
