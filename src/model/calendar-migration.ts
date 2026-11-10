import { deleteNode, type Ctx } from './commands';
import type { Doc } from './doc';
import { labelOf, periodAt } from './calendar';
import { titleOf } from './links';
import { normalize } from './search';
import { LINK_RE } from './format';
import type { NodeId } from './types';

export interface CalendarPlan {
  years: { y: number; target: NodeId; sources: NodeId[]; months: NodeId[] }[];
  quarters: NodeId[];
  error?: string;
}

/** Read-only preflight; no partial migration when the calendar is ambiguous. */
export function calendarPlan(doc: Doc): CalendarPlan {
  const plan: CalendarPlan = { years: [], quarters: [] };
  const groups = new Map<number, NodeId[]>();
  const rootYears = new Map<number, NodeId[]>();
  const add = (map: Map<number, NodeId[]>, y: number, id: NodeId) => map.set(y, [...(map.get(y) ?? []), id]);
  const fail = (id: NodeId) => { plan.error = `Не удалось перестроить календарь: проверьте дубли и структуру у «${doc.get(id).text}».`; };
  const calendarTag = (text: string) => /^@[ymwdq]\d/.test(text.trim());
  const roots = doc.get(doc.root).children;
  for (const id of roots) {
    const p = periodAt(doc, id);
    if (p?.kind === 'year') add(rootYears, p.y, id);
    const label = labelOf(doc.get(id).text);
    if (label?.kind === 'quarter' && !doc.get(id).mirrorOf) plan.quarters.push(id);
  }
  // Q1 before Q2 regardless of their current placement in the outline.
  plan.quarters.sort((a, b) => {
    const qa = labelOf(doc.get(a).text), qb = labelOf(doc.get(b).text);
    return (qa?.kind === 'quarter' ? qa.q : 0) - (qb?.kind === 'quarter' ? qb.q : 0);
  });
  for (const q of plan.quarters) for (const id of doc.get(q).children) {
    const p = periodAt(doc, id);
    // Shells retained by a previous migration need no further changes.
    if (p?.kind === 'quarter' && (!rootYears.has(p.y) || doc.get(id).children.some((c) => calendarTag(doc.get(c).text)))) {
      if (doc.get(id).mirrorOf) fail(id);
      add(groups, p.y, id);
    } else if (calendarTag(doc.get(id).text) && labelOf(doc.get(id).text)?.kind !== 'year') fail(id);
  }
  for (const [y, sources] of groups) {
    const existing = rootYears.get(y) ?? [];
    if (existing.length > 1) fail(existing[1]);
    const target = existing[0] ?? sources[0];
    const months = new Map<number, NodeId>();
    for (const source of [...existing, ...sources]) for (const id of doc.get(source).children) {
      const p = periodAt(doc, id);
      if (p?.kind !== 'month') {
        if (calendarTag(doc.get(id).text)) fail(id);
        continue; // Personal entries stay with their year shell.
      }
      if (months.has(p.m) || doc.get(id).mirrorOf) fail(id);
      months.set(p.m, id);
      // Validate calendar levels only, never inspect a day's personal contents.
      for (const w of doc.get(id).children) {
        const wp = periodAt(doc, w);
        if (wp?.kind !== 'week') { if (calendarTag(doc.get(w).text)) fail(w); continue; }
        if (doc.get(w).mirrorOf) fail(w);
        for (const d of doc.get(w).children) {
          const dp = periodAt(doc, d);
          if (calendarTag(doc.get(d).text) && dp?.kind !== 'day') fail(d);
          if (dp?.kind === 'day' && doc.get(d).mirrorOf) fail(d);
        }
      }
    }
    if (doc.get(target).mirrorOf) fail(target);
    plan.years.push({ y, target, sources, months: [...months].sort(([a], [b]) => a - b).map(([, id]) => id) });
  }
  plan.years.sort((a, b) => a.y - b.y);
  return plan;
}

/** Move physical nodes without unfolding them or changing their content/IDs. */
function move(doc: Doc, id: NodeId, parent: NodeId, index: number): void {
  const n = doc.get(id);
  if (n.parent === parent && doc.index(id) === index) return;
  doc.apply({ t: 'move', id, from: { parent: n.parent!, order: n.order }, to: { parent, order: doc.orderAt(parent, index + (n.parent === parent && doc.index(id) < index ? 1 : 0)) } });
}

/** Recompute the plan in the transaction, immediately before applying it. */
export function rebuildCalendar(ctx: Ctx): { changed: boolean; retained: string[]; error?: string } {
  const { doc, rows } = ctx;
  const plan = calendarPlan(doc);
  if (plan.error || !plan.years.length) return { changed: false, retained: [], error: plan.error };
  rows.expectMany();
  const linked = new Set<string>();
  // Links are title-based. Conservatively protect every shell with a referenced title,
  // including references in the trash, so restoring an entry cannot break its link.
  for (const n of doc.nodes.values()) for (const text of [n.text, n.note]) {
    for (const match of text.matchAll(new RegExp(LINK_RE.source, 'g'))) linked.add(normalize(titleOf(match[1])));
  }
  const retained: string[] = [];
  const cleanup = (id: NodeId) => {
    const n = doc.get(id);
    const reasons: string[] = [];
    if (n.children.length || n.note || n.strokes?.length || n.todo || n.done || n.paraOrigin || n.text.split(/\s+/).some((word) => word && !/^@[yq]\d+$/.test(word))) reasons.push('есть свои данные');
    if (doc.hasMirrors(id) || n.mirrorOf || linked.has(normalize(titleOf(n.text)))) reasons.push('есть ссылки или зеркала');
    if (reasons.length) retained.push(`${n.text}: ${reasons.join(', ')}`);
    else deleteNode(ctx, id);
  };
  const root = [...doc.get(doc.root).children];
  const anchor = Math.min(...plan.quarters.map((id) => root.indexOf(id)));
  for (const year of plan.years) {
    if (doc.get(year.target).parent !== doc.root) move(doc, year.target, doc.root, anchor);
    // Move in sorted order before any personal children, preserving their relative order.
    year.months.forEach((id, index) => move(doc, id, year.target, index));
    for (const source of year.sources) if (source !== year.target) cleanup(source);
  }
  for (const q of plan.quarters) cleanup(q);
  const years = doc.get(doc.root).children.filter((id) => periodAt(doc, id)?.kind === 'year')
    .sort((a, b) => (periodAt(doc, a)!.y - periodAt(doc, b)!.y));
  // Put the calendar where the first quarter was; leave all other root nodes in order.
  const otherBefore = root.slice(0, anchor).filter((id) => doc.inOutline(id) && doc.get(id).parent === doc.root && !years.includes(id)).length;
  years.forEach((id, i) => move(doc, id, doc.root, otherBefore + i));
  return { changed: true, retained };
}
