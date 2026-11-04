import { periodStart, retentionStart, validRange } from './history-range';

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

describe('Quick history periods', () => {
  it('uses seven full days for a week', () => {
    const end = new Date(2026, 2, 30, 12).getTime();
    expect(end - periodStart(end, '1w')).toBe(7 * 86400000);
  });
  it.each([[2026, 2, 31, '1mo', 2026, 1, 28], [2024, 2, 31, '1mo', 2024, 1, 29],
    [2024, 1, 29, '1y', 2023, 1, 28], [2024, 1, 29, '2y', 2022, 1, 28],
    [2026, 0, 31, '1mo', 2025, 11, 31]] as const)
    ('clamps calendar subtraction %s/%s/%s %s', (y,m,d,period,ey,em,ed) => {
      const result = new Date(periodStart(new Date(y,m,d,22,14,25,123).getTime(), period));
      expect([result.getFullYear(),result.getMonth(),result.getDate(),result.getHours(),result.getMinutes(),result.getSeconds(),result.getMilliseconds()])
        .toEqual([ey,em,ed,22,14,25,123]);
    });
});
