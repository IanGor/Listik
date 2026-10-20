import { Show, onMount } from 'solid-js';
import { timeCommandBefore, timeOfDay, TIME_COMMAND } from '../model/time';
import type { Outliner } from './outliner';

/**
 * Quick capture: one line over the outline for a thought that came up
 * mid-work, to the Inbox, without going there (`Outliner.capture`). Not a
 * dialog: nothing is dimmed and the outline does not move. Enter keeps it,
 * Esc (or leaving the line) closes it, what was typed waiting for next time;
 * either way the caret goes back where it was in the outline. Tags, links
 * and `/time` work as in a bullet, being text.
 *
 * Under the header on a computer; on a phone, a sheet over the keyboard.
 * Opened by Ctrl+Shift+Space, the tray in the header, or the menu.
 */
export function QuickCapture(props: { o: Outliner }) {
  const o = props.o;
  return (
    <Show when={o.captureOpen()}>
      <Line o={o} />
    </Show>
  );
}

function Line(props: { o: Outliner }) {
  const o = props.o;
  let input!: HTMLInputElement;

  onMount(() => {
    input.value = o.captureDraft;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  const close = () => {
    o.captureDraft = input.value;
    o.closeCapture();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The line's own keys: none of them reaches the outline's.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return close();
      o.captureDraft = '';
      input.value = '';
      o.capture(text);
      o.closeCapture();
    }
  };

  const onInput = () => {
    const caret = input.selectionStart ?? input.value.length;
    if (!timeCommandBefore(input.value, caret)) return;
    const start = caret - TIME_COMMAND.length;
    const time = timeOfDay();
    input.value = input.value.slice(0, start) + time + input.value.slice(caret);
    input.setSelectionRange(start + time.length, start + time.length);
  };

  return (
    <div class="capture" role="dialog" aria-label="Запись в Inbox">
      <svg class="capture-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
      <input
        ref={input}
        class="capture-input"
        type="text"
        enterkeyhint="send"
        autocomplete="off"
        placeholder="Мысль → Inbox"
        aria-label="Запись в Inbox"
        onKeyDown={onKeyDown}
        onInput={onInput}
        onBlur={close}
      />
      <span class="capture-hint" aria-hidden="true">Enter — записать · Esc</span>
    </div>
  );
}
