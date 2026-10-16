/**
 * Caret helpers. Everything works in plain-text offsets within an element,
 * whatever its inner markup (static rows may contain tag spans).
 */

/** Text offset of `node`/`offset` inside `root`. */
export function offsetIn(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Selection [start, end] as text offsets in `el`, or null if the selection is elsewhere. */
export function selectionIn(el: HTMLElement): [number, number] | null {
  const sel = getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  return [offsetIn(el, r.startContainer, r.startOffset), offsetIn(el, r.endContainer, r.endOffset)];
}

export function setCaret(el: HTMLElement, offset: number): void {
  const sel = getSelection();
  if (!sel) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (left <= n.length) {
      sel.collapse(n, left);
      return;
    }
    left -= n.length;
  }
  sel.collapse(el, el.childNodes.length);
}

/** Text offset in `el` nearest to a viewport point, or null if the point is not over `el`'s text. */
export function offsetFromPoint(el: HTMLElement, x: number, y: number): number | null {
  let node: Node | null = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) ({ offsetNode: node, offset } = p);
  } else {
    // Safari < 17.4 and older Chromium.
    const r = (document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null })
      .caretRangeFromPoint?.(x, y);
    if (r) ({ startContainer: node, startOffset: offset } = r);
  }
  return node && el.contains(node) ? offsetIn(el, node, offset) : null;
}

export function lineHeight(el: HTMLElement): number {
  return parseFloat(getComputedStyle(el).lineHeight) || 20;
}

/** The caret's rect; null when it has none (e.g. an empty line). */
function caretRect(): DOMRect | null {
  const sel = getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  const rects = r.getClientRects();
  return rects.length ? rects[0] : null;
}

export function caretOnFirstLine(el: HTMLElement): boolean {
  const r = caretRect();
  return !r || r.top - el.getBoundingClientRect().top < lineHeight(el) / 2;
}

export function caretOnLastLine(el: HTMLElement): boolean {
  const r = caretRect();
  return !r || el.getBoundingClientRect().bottom - r.bottom < lineHeight(el) / 2;
}

/** Horizontal caret position, to keep the column when moving between rows. */
export function caretX(el: HTMLElement): number {
  return caretRect()?.left ?? el.getBoundingClientRect().left;
}
