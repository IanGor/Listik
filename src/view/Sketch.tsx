import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { SHEET, decodePoints, drawStroke, eraseStrokes, newStroke, pathData, simplify, smooth, touches, type Point } from '../model/sketch';
import type { NodeId, Stroke } from '../model/types';
import type { Outliner } from './outliner';
import { narrow } from './screen';

/** Width of a pen line and of a marker band, in sheet units (model/sketch.ts). */
const PEN = 2.6;
const MARK = 24;
/** Points of a line closer than this to the last one are skipped while drawing, units. */
const MIN_STEP = 0.25;
/**
 * Points within this of the line through their neighbours are dropped when a
 * line is kept, units: little enough to keep small handwriting as it was
 * drawn (the curve goes through the points that stay).
 */
const TOLERANCE = 0.15;
/**
 * How far along the line the tremor of a hand is smoothed out (`smooth`),
 * units; `?smooth=N` in the address tries another, 0 turns it off.
 */
const SMOOTH = 3;
/** Reach of the eraser around the pen's tip, px. */
const ERASER = 10;

type Tool = 'pen' | 'mark' | 'eraser';

interface Shown {
  stroke: Stroke;
  points: Point[];
  path: string;
}

/**
 * The zoomed-in bullet's sketch: a sheet beside its list (below it on a
 * phone), the width of the pane, running down without end — there is
 * always a screen of it below the lowest line. Apple Pencil (or a mouse)
 * draws; a finger scrolls. The text keeps the caret: drawing never takes
 * focus from the bullet being typed. A phone only shows the sketch.
 */
export function Sketch(props: { o: Outliner; id: NodeId }) {
  const o = props.o;
  const id = props.id;
  let scroller!: HTMLDivElement;
  let svg!: SVGSVGElement;
  let live!: SVGPathElement;

  o.nodes.acquire(id);
  onCleanup(() => o.nodes.release(id));

  const [tool, setTool] = createSignal<Tool>('pen');
  /** Lines under the eraser right now: hidden, gone for good when the pen lifts. */
  const [erased, setErased] = createSignal<ReadonlySet<string>>(new Set());
  /** The pane's size in px. */
  const [size, setSize] = createSignal({ width: 0, height: 0 });

  // Decoded once per line: a sketch with hundreds of lines redraws only what changed.
  const cache = new Map<string, Shown>();
  const lines = createMemo(() => {
    o.nodes.track(id);
    const strokes = o.doc.has(id) ? o.doc.content(id).strokes ?? [] : [];
    const seen = new Set<string>();
    const out = strokes.map((s) => {
      seen.add(s.id);
      let v = cache.get(s.id);
      if (!v || v.stroke !== s) {
        const points = decodePoints(s.d);
        v = { stroke: s, points, path: pathData(points) };
        cache.set(s.id, v);
      }
      return v;
    });
    for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
    return out;
  });
  const visible = (tool: Stroke['tool']) => lines().filter((l) => l.stroke.tool === tool && !erased().has(l.stroke.id));

  /** Sheet units per px. */
  const unit = () => (size().width ? SHEET / size().width : 1);
  /** The sheet's length: the lowest line and a screen more. */
  const height = createMemo(() => {
    let bottom = 0;
    for (const l of lines()) for (const [, y] of l.points) if (y > bottom) bottom = y;
    return Math.ceil(bottom + size().height * unit());
  });

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize[0];
      setSize({ width: box.inlineSize, height: box.blockSize });
    });
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
    // Apple Pencil draws instead of scrolling; a finger still scrolls (Safari tells them apart by `touchType`).
    const stylus = (e: TouchEvent) => {
      if ([...e.touches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus')) e.preventDefault();
    };
    scroller.addEventListener('touchstart', stylus, { passive: false });
    scroller.addEventListener('touchmove', stylus, { passive: false });
    onCleanup(() => {
      scroller.removeEventListener('touchstart', stylus);
      scroller.removeEventListener('touchmove', stylus);
    });
  });

  let gesture: { pointer: number; rect: DOMRect; points: Point[]; hit: Set<string>; samples: number; started: number } | null = null;
  /** `?ink` in the address: how many points a second the pen gave in the last line, and whether they came coalesced. */
  const debug = new URLSearchParams(location.search).has('ink');
  const [rate, setRate] = createSignal('');
  const sigma = Number(new URLSearchParams(location.search).get('smooth') ?? SMOOTH) || 0;
  const at = (e: PointerEvent, rect: DOMRect): Point => {
    const k = SHEET / rect.width;
    return [(e.clientX - rect.left) * k, (e.clientY - rect.top) * k];
  };
  const drawable = () => !o.readOnly && !narrow();

  const erase = (p: Point) => {
    const g = gesture!;
    const reach = ERASER * unit();
    let more = false;
    for (const l of lines()) {
      if (g.hit.has(l.stroke.id)) continue;
      if (touches(l.points, p, reach + (l.stroke.tool === 'mark' ? MARK : PEN) / 2)) {
        g.hit.add(l.stroke.id);
        more = true;
      }
    }
    if (more) setErased(new Set(g.hit));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!drawable() || e.pointerType === 'touch' || (e.pointerType === 'mouse' && e.button !== 0) || gesture) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    const rect = svg.getBoundingClientRect();
    const p = at(e, rect);
    gesture = { pointer: e.pointerId, rect, points: [p], hit: new Set(), samples: 1, started: e.timeStamp };
    if (tool() === 'eraser') erase(p);
    else {
      live.setAttribute('class', tool() === 'mark' ? 'mark' : 'pen');
      live.setAttribute('d', pathData(gesture.points));
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const g = gesture;
    if (!g || e.pointerId !== g.pointer) return;
    // All the samples since the last event: Apple Pencil reports 240 a second, events come at most once a frame.
    const samples = e.getCoalescedEvents?.() ?? [];
    g.samples += samples.length || 1;
    for (const s of samples.length ? samples : [e]) {
      const p = at(s, g.rect);
      if (tool() === 'eraser') {
        erase(p);
        continue;
      }
      const last = g.points[g.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP) g.points.push(p);
    }
    if (tool() === 'eraser') return;
    // Where the pen is about to be, drawn ahead and never kept: the line keeps up with the tip.
    const ahead = (e.getPredictedEvents?.() ?? []).map((s) => at(s, g.rect));
    live.setAttribute('d', pathData(smooth(ahead.length ? [...g.points, ...ahead] : g.points, sigma)));
  };

  const onPointerUp = (e: PointerEvent) => {
    const g = gesture;
    if (!g || e.pointerId !== g.pointer) return;
    gesture = null;
    if (debug) {
      const seconds = (e.timeStamp - g.started) / 1000;
      setRate(`${e.pointerType}: ${seconds > 0 ? Math.round(g.samples / seconds) : 0} точек/с, coalesced: ${'getCoalescedEvents' in e ? 'есть' : 'нет'}, predicted: ${'getPredictedEvents' in e ? 'есть' : 'нет'}, smooth: ${sigma}`);
    }
    const t = tool();
    if (t === 'eraser') {
      if (g.hit.size) o.sketch((ctx) => eraseStrokes(ctx, id, g.hit));
      setErased(new Set<string>());
    } else {
      o.sketch((ctx) => drawStroke(ctx, id, newStroke(t, simplify(smooth(g.points, sigma), TOLERANCE))));
      live.setAttribute('d', '');
    }
  };

  const button = (t: Tool, label: string, icon: string) => (
    <button
      type="button"
      class="sketch-tool"
      classList={{ on: tool() === t }}
      title={label}
      aria-label={label}
      aria-pressed={tool() === t}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setTool(t)}
      innerHTML={icon}
    />
  );

  return (
    <section class="sketch" aria-label="Скетч">
      {/* No default on mousedown: the caret stays in the bullet being typed. */}
      <div ref={scroller} class="sketch-sheet" onMouseDown={(e) => e.preventDefault()}>
        <svg
          ref={svg}
          viewBox={`0 0 ${SHEET} ${height()}`}
          classList={{ drawable: drawable(), erasing: tool() === 'eraser' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <g class="mark" stroke-width={MARK}>
            <For each={visible('mark')}>{(l) => <path d={l.path} />}</For>
          </g>
          <g class="pen" stroke-width={PEN}>
            <For each={visible('pen')}>{(l) => <path d={l.path} />}</For>
          </g>
          <path ref={live} class="pen" stroke-width={tool() === 'mark' ? MARK : PEN} />
        </svg>
      </div>
      <Show when={drawable()}>
        <Show when={debug && rate()}>
          <div class="sketch-rate">{rate()}</div>
        </Show>
        <div class="sketch-tools" role="toolbar" aria-label="Инструменты скетча">
          {button('pen', 'Перо', PEN_ICON)}
          {button('mark', 'Маркер', MARK_ICON)}
          {button('eraser', 'Ластик', ERASER_ICON)}
          <span class="sketch-sep" />
          <button type="button" class="sketch-tool" title="Отменить" aria-label="Отменить" onMouseDown={(e) => e.preventDefault()} onClick={() => o.undo()} innerHTML={UNDO_ICON} />
          <button type="button" class="sketch-tool" title="Повторить" aria-label="Повторить" onMouseDown={(e) => e.preventDefault()} onClick={() => o.redo()} innerHTML={REDO_ICON} />
        </div>
      </Show>
    </section>
  );
}

const svgIcon = (body: string) =>
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const PEN_ICON = svgIcon('<path d="M4 20l1.2-4.6L16.5 4.1a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M14.5 6l3.5 3.5"/>');
const MARK_ICON = svgIcon('<path d="M9 15l-3 3h5l1-1"/><path d="M9 15l7.8-7.8a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L12 18z"/><path class="sketch-swatch" d="M4 21.3h16"/>');
const ERASER_ICON = svgIcon('<path d="M8.5 19.5L4 15a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l4.9 4.9a2 2 0 0 1 0 2.8L12.4 19.5z"/><path d="M8.5 19.5H20"/><path d="M9 7.5l7 7"/>');
const UNDO_ICON = svgIcon('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>');
const REDO_ICON = svgIcon('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>');
