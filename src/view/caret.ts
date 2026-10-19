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

/** The DOM position of text offset `offset` in `el`. */
function pointAt(el: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (left <= n.length) return [n, left];
    left -= n.length;
  }
  return [el, el.childNodes.length];
}

export function setCaret(el: HTMLElement, offset: number): void {
  getSelection()?.collapse(...pointAt(el, offset));
}

/** Selects from text offset `anchor` to `focus` in `el`; `focus` may come first. */
export function selectRange(el: HTMLElement, anchor: number, focus: number): void {
  getSelection()?.setBaseAndExtent(...pointAt(el, anchor), ...pointAt(el, focus));
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

/**
 * Like offsetFromPoint, for any point: above `el` is its start, below it its
 * end, to the side the nearest place on that line. For a drag that leaves
 * the element.
 */
export function offsetNear(el: HTMLElement, x: number, y: number): number {
  const r = el.getBoundingClientRect();
  const length = el.textContent?.length ?? 0;
  if (y < r.top) return 0;
  if (y >= r.bottom) return length;
  return offsetFromPoint(el, Math.min(Math.max(x, r.left + 1), r.right - 1), y) ?? length;
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
