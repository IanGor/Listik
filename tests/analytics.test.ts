import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { appendUsage, devicePlatform, usageEvents, type UsageEvent } from '../src/persist/analytics';

it('distinguishes phone, tablet and touch laptop independently of window size', () => {
  expect(devicePlatform(412, 915, true, true)).toBe('phone');
  expect(devicePlatform(834, 1194, true, true)).toBe('tablet');
  expect(devicePlatform(1440, 900, true, false)).toBe('laptop');
});

it('keeps events across database reads in a separate local journal', async () => {
  const event: UsageEvent = { schema: 1, time: 1, session: 'session', device: 'device', platform: 'tablet', os: 'iOS', width: 834, height: 780, action: 'editbar.Вложить', input: 'touch', softwareKeyboard: true };
  await appendUsage([event]);
  expect(await usageEvents()).toEqual([event]);
});
