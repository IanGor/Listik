import { describe, expect, it } from 'vitest';
import { timeCommandBefore, timeOfDay } from '../src/model/time';

describe('timeOfDay', () => {
  it('is the local time as HH:MM, 24-hour, zero-padded', () => {
    expect(timeOfDay(new Date(2026, 9, 19, 9, 5, 59))).toBe('09:05');
    expect(timeOfDay(new Date(2026, 9, 19, 23, 40))).toBe('23:40');
    expect(timeOfDay(new Date(2026, 9, 19, 0, 0))).toBe('00:00');
  });
});

describe('timeCommandBefore', () => {
  it('finds /time right before the caret, as a word of its own', () => {
    expect(timeCommandBefore('/time', 5)).toBe(true);
    expect(timeCommandBefore('встреча /time', 13)).toBe(true);
    expect(timeCommandBefore('встреча\t/time и дальше', 13)).toBe(true);
  });

  it('ignores it glued to a word, cut short, or away from the caret', () => {
    expect(timeCommandBefore('a/time', 6)).toBe(false);
    expect(timeCommandBefore('https://x.ru/time', 17)).toBe(false);
    expect(timeCommandBefore('/tim', 4)).toBe(false);
    expect(timeCommandBefore('/time later', 11)).toBe(false);
    expect(timeCommandBefore('', 0)).toBe(false);
  });
});
