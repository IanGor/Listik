import type { Doc } from './doc';
import { parseTags } from './tags';
import { periodAt } from './calendar';
import type { NodeId } from './types';

/**
 * One-time tagging of the projects made before `#project` marked them
 * (model/kanban.ts): a bullet signed `@work` or `@home`, in its text or its
 * note, gets `#project` beside the sign. Tasks and the days of the calendar
 * are left (a task signed `@work` is not a project), as are mirrors and
 * bullets that have the tag already.
 */
const AREAS = ['@work', '@home'];

export function projectTags(doc: Doc): { id: NodeId; field: 'text' | 'note'; to: string }[] {
  const out: { id: NodeId; field: 'text' | 'note'; to: string }[] = [];
  doc.walk(doc.root, (n) => {
    if (n.id === doc.root || n.mirrorOf || n.todo || n.done) return;
    const tags = [...parseTags(n.text), ...parseTags(n.note)];
    if (tags.includes('project') || !tags.some((t) => AREAS.includes(t))) return;
    if (periodAt(doc, n.id)) return;
    const field = parseTags(n.text).some((t) => AREAS.includes(t)) ? 'text' : 'note';
    out.push({ id: n.id, field, to: `${n[field]} #project` });
  });
  return out;
}
