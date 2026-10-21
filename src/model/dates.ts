import { dayOf, periodText, type Period } from './calendar';

/**
 * Days by name, typed as `@words` (in English: `@` is on the English
 * layout) and written as the day's tags in the calendar's own form,
 * `@d22 @m10 @y26 @четверг`: a filter by them finds the day and the
 * entries alike. `@today`, `@tomorrow`, `@yesterday`; `@monday`…`@sunday`
 * are the days of this week, Monday first as the calendar's weeks;
 * `@lastmonday`, `@nextmonday` and so on, of the week before and after.
 * Taken from the `@` suggestions (view/Suggest.tsx), or put in as soon as
 * a space follows the word (view/Row.tsx, view/QuickCapture.tsx).
 */

const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Every word, in the order the suggestions offer them. */
export const DATE_WORDS: readonly string[] = [
  'today',
  'tomorrow',
  'yesterday',
  ...WEEK,
  ...WEEK.map((w) => `last${w}`),
  ...WEEK.map((w) => `next${w}`),
];

/** What the suggestions offer with nothing typed after `@` yet. */
const FIRST = 3;

/** The day `word` (without its `@`, any case) stands for on `now`'s date, by the device's clock; null for any other word. */
export function dateOf(word: string, now = new Date()): Period | null {
  const shift = (days: number) => dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  const w = word.toLowerCase();
  if (w === 'today') return shift(0);
  if (w === 'tomorrow') return shift(1);
  if (w === 'yesterday') return shift(-1);
  const m = /^(last|next)?([a-z]+)$/.exec(w);
  const day = m ? WEEK.indexOf(m[2]) : -1;
  if (!m || day < 0) return null;
  const monday = -((now.getDay() + 6) % 7);
  return shift(monday + day + (m[1] === 'last' ? -7 : m[1] === 'next' ? 7 : 0));
}

/** The tags `word` becomes; null for a word that is no day. */
export function dateText(word: string, now = new Date()): string | null {
  const p = dateOf(word, now);
  return p && periodText(p);
}

const SHORT_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** The day for people, beside a suggestion: «чт 22.10». */
export function dateHint(word: string, now = new Date()): string {
  const p = dateOf(word, now);
  if (p?.kind !== 'day') return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${SHORT_WEEKDAYS[new Date(p.y, p.m - 1, p.d).getDay()]} ${two(p.d)}.${two(p.m)}`;
}

/** Words that start with the query; today, tomorrow and yesterday only, with nothing typed. */
export function matchDates(query: string): string[] {
  const q = query.toLowerCase();
  return q ? DATE_WORDS.filter((w) => w.startsWith(q)) : DATE_WORDS.slice(0, FIRST);
}

/**
 * A day's word typed and then a space, just before `caret`: where its `@`
 * is and the tags it becomes. The word stands on its own, as a tag does
 * (model/complete.ts): at the start, or after whitespace or "(".
 */
export function dateWordBefore(text: string, caret: number, now = new Date()): { start: number; text: string } | null {
  if (caret < 1 || !/\s/.test(text[caret - 1])) return null;
  const m = /(?:^|[\s(])@([a-zA-Z]+)$/.exec(text.slice(0, caret - 1));
  if (!m) return null;
  const tags = dateText(m[1], now);
  return tags ? { start: caret - 2 - m[1].length, text: tags } : null;
}
