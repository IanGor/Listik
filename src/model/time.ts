/** Typed in a bullet or a note, becomes the current time (view/Row.tsx). */
export const TIME_COMMAND = '/time';

/** The device's local time of day as HH:MM, 24-hour. */
export function timeOfDay(d = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Whether the text just before `caret` is the time command, standing as a
 * word of its own: at the start or after whitespace (not `a/time`, not a URL).
 */
export function timeCommandBefore(text: string, caret: number): boolean {
  const start = caret - TIME_COMMAND.length;
  if (start < 0 || text.slice(start, caret) !== TIME_COMMAND) return false;
  return start === 0 || /\s/.test(text[start - 1]);
}
