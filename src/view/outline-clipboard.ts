import type { Tree } from '../model/outline-text';
import type { Outliner } from './outliner';

export const LINE_TEXT = 'application/x-listik-line-text';
const BULLETS = 'application/x-listik-bullets';

export function copyBullets(e: ClipboardEvent, o: Outliner): void {
  const clipboard = e.clipboardData;
  if (!clipboard || e.defaultPrevented || !o.selection()) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable], .menu')) return;

  const bullets = [];
  const depths: number[] = [];
  const plain: string[] = [];
  for (const key of o.selectedSet()) {
    const depth = o.rows.depths[o.rows.indexOf(key)];
    while (depths.length && depths[depths.length - 1] >= depth) depths.pop();
    const { text, note, todo, done } = o.contentOf(key);
    bullets.push({ text, note, todo, done, depth: depths.length });
    const task = todo || done ? (done ? '[x] ' : '[ ] ') : '';
    plain.push(`${'  '.repeat(depths.length)}- ${task}${text}`);
    depths.push(depth);
  }
  if (!bullets.length) return;
  e.preventDefault();
  clipboard.setData('text/plain', plain.join('\n'));
  clipboard.setData(BULLETS, JSON.stringify(bullets));
}

export function readBullets(clipboard: DataTransfer): Tree[] | null {
  const raw = clipboard.getData(BULLETS);
  if (!raw) return null;
  try {
    const bullets: unknown = JSON.parse(raw);
    if (!Array.isArray(bullets) || !bullets.length) return null;
    const roots: Tree[] = [];
    const parents: Tree[] = [];
    for (const bullet of bullets) {
      if (!bullet || typeof bullet !== 'object') return null;
      const { text, note, todo, done, depth } = bullet;
      if (typeof text !== 'string' || typeof note !== 'string' ||
          typeof todo !== 'boolean' || typeof done !== 'boolean' ||
          !Number.isInteger(depth) || depth < 0 || depth > parents.length) return null;
      const tree: Tree = { text, note, todo, done, children: [] };
      (depth === 0 ? roots : parents[depth - 1].children).push(tree);
      parents.length = depth;
      parents.push(tree);
    }
    return roots;
  } catch {
    return null;
  }
}
