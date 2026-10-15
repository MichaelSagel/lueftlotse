import { retentionStart, validRange } from './history-range';

describe('Calendar retention and ranges', () => {
  it('clamps February 29 to February 28 while preserving local time', () => {
    const cutoff = new Date(retentionStart(new Date(2024, 1, 29, 14, 15, 16, 123).getTime()));
    expect(cutoff.getFullYear()).toBe(2022); expect(cutoff.getMonth()).toBe(1); expect(cutoff.getDate()).toBe(28);
    expect(cutoff.getHours()).toBe(14); expect(cutoff.getMinutes()).toBe(15); expect(cutoff.getMilliseconds()).toBe(123);
  });
  it('accepts exact retention boundaries and rejects a millisecond outside them', () => {
    const now = new Date(2026, 9, 14, 12).getTime(); const start = retentionStart(now);
    expect(validRange({ start, end: now }, now)).toBe(true);
    expect(validRange({ start: start - 1, end: now }, now)).toBe(false);
    expect(validRange({ start, end: now + 1 }, now)).toBe(false);
    expect(validRange({ start: NaN, end: now }, now)).toBe(false);
  });
});
