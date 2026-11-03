import { appendUsage, devicePlatform, usageEvents, type UsageEvent } from '../persist/analytics';
import { dateStamp, download } from './files';
import { keyboard } from './screen';

let pending: UsageEvent[] = [];
let flushNow: (() => Promise<void>) | undefined;
let recordAction: ((action: string) => void) | undefined;

/** Semantic events complement control IDs; arguments are deliberately never recorded. */
export function trackUsage(action: string) { recordAction?.(action); }

export async function exportUsage() {
  await flushNow?.();
  if (pending.length) throw new Error('Usage journal has unsaved events');
  download(`listik-usage-${dateStamp()}.json`, 'application/json', JSON.stringify({ schema: 1, events: await usageEvents() }, null, 2));
}

/** No document content, node IDs, query strings or typed characters enter this log. */
export function watchUsage() {
  if (new URLSearchParams(location.search).has('demo') || new URLSearchParams(location.search).has('sample')) return;
  const session = crypto.randomUUID();
  let device: string = crypto.randomUUID();
  try {
    device = localStorage.getItem('listik-usage-device') ?? device;
    localStorage.setItem('listik-usage-device', device);
  } catch { /* Storage restrictions must not stop the editor. */ }
  const ua = navigator.userAgent;
  const platform = devicePlatform(screen.width, screen.height, navigator.maxTouchPoints > 0, /Android|iPhone|iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 0));
  const os = /iPad|iPhone/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 0) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'Linux';
  let input = 'unknown';
  const record = (action: string) => {
    pending.push({ schema: 1, time: Date.now(), session, device, platform, os, width: innerWidth, height: innerHeight, action, input, softwareKeyboard: keyboard() });
  };
  recordAction = record;
  // Serialize flushes; an export must include the batch already being written.
  let writing = Promise.resolve();
  flushNow = () => {
    const batch = pending;
    pending = [];
    writing = writing.then(async () => {
      if (!batch.length) return;
      try { await appendUsage(batch); }
      catch { pending = [...batch, ...pending].slice(-1000); }
    });
    return writing;
  };
  window.addEventListener('pointerdown', e => { input = e.pointerType; }, { capture: true, passive: true });
  window.addEventListener('click', e => {
    const target = e.target instanceof Element ? e.target.closest('[data-action], .bullet, .toggle, .check, .tag, .crumb') : null;
    if (target) record(target.getAttribute('data-action') ?? `outline.${['bullet', 'toggle', 'check', 'tag', 'crumb'].find(c => target.classList.contains(c))}`);
  }, true);
  window.addEventListener('keydown', e => {
    input = 'keyboard';
    if (e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'].includes(e.key)) {
      record(`key.${e.ctrlKey || e.metaKey ? 'mod.' : ''}${e.altKey ? 'alt.' : ''}${e.shiftKey ? 'shift.' : ''}${e.code}`);
    }
  }, true);
  let edited: ReturnType<typeof setTimeout>;
  window.addEventListener('input', e => {
    const target = e.target instanceof Element ? e.target : null;
    // Coalesce a typing burst, not a stream of characters.
    clearTimeout(edited);
    edited = setTimeout(() => record(target?.getAttribute('data-action') ?? (target?.classList.contains('note') ? 'edit.note' : 'edit.text')), 700);
  }, true);
  window.addEventListener('pagehide', () => { record('session.hide'); void flushNow?.(); });
  document.addEventListener('visibilitychange', () => {
    record(document.hidden ? 'session.background' : 'session.foreground');
    void flushNow?.();
  });
  setInterval(() => { void flushNow?.(); }, 1000);
  record('session.start');
}
