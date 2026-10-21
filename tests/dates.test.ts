import { describe, expect, it } from 'vitest';
import { DATE_WORDS, dateHint, dateText, dateWordBefore, matchDates } from '../src/model/dates';

// Wednesday, 21 October 2026, in the evening.
const wed = new Date(2026, 9, 21, 22, 30);

describe('day words', () => {
  it('today, tomorrow, yesterday are the day\'s tags in the calendar\'s form', () => {
    expect(dateText('today', wed)).toBe('@d21 @m10 @y26 @среда');
    expect(dateText('tomorrow', wed)).toBe('@d22 @m10 @y26 @четверг');
    expect(dateText('yesterday', wed)).toBe('@d20 @m10 @y26 @вторник');
    expect(dateText('Today', wed)).toBe('@d21 @m10 @y26 @среда');
  });

  it('weekdays are of this week, Monday to Sunday, the past ones too; last and next are the weeks around it', () => {
    expect(dateText('monday', wed)).toBe('@d19 @m10 @y26 @понедельник');
    expect(dateText('wednesday', wed)).toBe('@d21 @m10 @y26 @среда');
    expect(dateText('sunday', wed)).toBe('@d25 @m10 @y26 @воскресенье');
    expect(dateText('lastmonday', wed)).toBe('@d12 @m10 @y26 @понедельник');
    expect(dateText('lastsunday', wed)).toBe('@d18 @m10 @y26 @воскресенье');
    expect(dateText('nextmonday', wed)).toBe('@d26 @m10 @y26 @понедельник');
    expect(dateText('nextsunday', wed)).toBe('@d01 @m11 @y26 @воскресенье');
  });

  it('a week runs from Monday: on Sunday "monday" is six days back, on Monday "sunday" six days on', () => {
    expect(dateText('monday', new Date(2026, 9, 25))).toBe('@d19 @m10 @y26 @понедельник');
    expect(dateText('nextmonday', new Date(2026, 9, 25))).toBe('@d26 @m10 @y26 @понедельник');
    expect(dateText('sunday', new Date(2026, 9, 19))).toBe('@d25 @m10 @y26 @воскресенье');
    expect(dateText('lastsunday', new Date(2026, 9, 19))).toBe('@d18 @m10 @y26 @воскресенье');
  });

  it('crosses months and years, 29 February only in a leap year', () => {
    expect(dateText('tomorrow', new Date(2026, 11, 31))).toBe('@d01 @m01 @y27 @пятница');
    expect(dateText('nextmonday', new Date(2026, 11, 30))).toBe('@d04 @m01 @y27 @понедельник');
    expect(dateText('lastmonday', new Date(2027, 0, 4))).toBe('@d28 @m12 @y26 @понедельник');
    expect(dateText('yesterday', new Date(2028, 2, 1))).toBe('@d29 @m02 @y28 @вторник');
    expect(dateText('yesterday', new Date(2027, 2, 1))).toBe('@d28 @m02 @y27 @воскресенье');
  });

  it('every word is a day; any other is not', () => {
    expect(DATE_WORDS).toHaveLength(24);
    for (const w of DATE_WORDS) expect(dateText(w, wed)).toMatch(/^@d\d\d @m\d\d @y\d\d @\p{L}+$/u);
    for (const w of ['', 'mon', 'lastday', 'nexttoday', 'понедельник', 'monday1']) expect(dateText(w, wed)).toBeNull();
  });

  it('suggests by the start of the word, the three nearest days with nothing typed; the hint is the date', () => {
    expect(matchDates('')).toEqual(['today', 'tomorrow', 'yesterday']);
    expect(matchDates('t')).toEqual(['today', 'tomorrow', 'tuesday', 'thursday']);
    expect(matchDates('NextM')).toEqual(['nextmonday']);
    expect(matchDates('m10')).toEqual([]);
    expect(dateHint('tomorrow', wed)).toBe('чт 22.10');
    expect(dateHint('nextsunday', wed)).toBe('вс 01.11');
  });
});

describe('a day word and a space', () => {
  it('is found right before the caret, standing on its own', () => {
    expect(dateWordBefore('@today ', 7, wed)).toEqual({ start: 0, text: '@d21 @m10 @y26 @среда' });
    expect(dateWordBefore('созвон @tomorrow  после', 17, wed)).toEqual({ start: 7, text: '@d22 @m10 @y26 @четверг' });
    expect(dateWordBefore('(@monday ', 9, wed)).toEqual({ start: 1, text: '@d19 @m10 @y26 @понедельник' });
  });

  it('is not one without the space, inside a word or an address, or for another word', () => {
    expect(dateWordBefore('@today', 6, wed)).toBeNull();
    expect(dateWordBefore('a@today ', 8, wed)).toBeNull();
    expect(dateWordBefore('me@today ', 9, wed)).toBeNull();
    expect(dateWordBefore('@tod ', 5, wed)).toBeNull();
    expect(dateWordBefore('#today ', 7, wed)).toBeNull();
    expect(dateWordBefore('@today x', 8, wed)).toBeNull();
  });
});
