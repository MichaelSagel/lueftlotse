/** Subtract calendar years in local time, clamping leap day to February 28. */
export function retentionStart(now: number): number {
  const date = new Date(now);
  const month = date.getMonth();
  date.setFullYear(date.getFullYear() - 2);
  if (date.getMonth() !== month) date.setDate(0);
  return date.getTime();
}

export interface HistoryRange { readonly start: number; readonly end: number; }

export type HistoryPeriod = '5m' | '1h' | '24h' | '1w' | '1mo' | '1y' | '2y' | 'custom';

/** Subtract calendar months/years in local time, clamping the day. */
export function periodStart(end: number, period: Exclude<HistoryPeriod, 'custom'>): number {
  const durations = { '5m': 300000, '1h': 3600000, '24h': 86400000, '1w': 7 * 86400000 };
  if (period in durations) return end - durations[period as keyof typeof durations];
  const date = new Date(end);
  const day = date.getDate();
  date.setDate(1);
  if (period === '1mo') date.setMonth(date.getMonth() - 1);
  else date.setFullYear(date.getFullYear() - (period === '1y' ? 1 : 2));
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return date.getTime();
}

export function validRange(range: HistoryRange, now: number): boolean {
  return Number.isFinite(range.start) && Number.isFinite(range.end)
    && range.start < range.end && range.start >= retentionStart(now) && range.end <= now;
}
