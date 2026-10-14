/** Subtract calendar years in local time, clamping leap day to February 28. */
export function retentionStart(now: number): number {
  const date = new Date(now);
  const month = date.getMonth();
  date.setFullYear(date.getFullYear() - 2);
  if (date.getMonth() !== month) date.setDate(0);
  return date.getTime();
}

export interface HistoryRange { readonly start: number; readonly end: number; }

export function validRange(range: HistoryRange, now: number): boolean {
  return Number.isFinite(range.start) && Number.isFinite(range.end)
    && range.start < range.end && range.start >= retentionStart(now) && range.end <= now;
}
