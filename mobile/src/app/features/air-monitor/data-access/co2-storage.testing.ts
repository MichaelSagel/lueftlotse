import { vi } from 'vitest';
import { Co2Measurement, Co2Storage, PageCursor } from './co2-storage';
import { HistoryEnvelope } from '../domain/history-envelope';

export function testStorage(seed: Co2Measurement[] = []) {
  const rows = [...seed];
  const sorted = (start: number, end: number) => rows.map((row, key) => ({ row, key: key + 1 })).filter(({ row }) => row.time >= start && row.time <= end).sort((a, b) => a.row.time - b.row.time || a.key - b.key);
  const storage = {
    migrateMetadata: vi.fn(async () => {}),
    count: vi.fn(async () => rows.length),
    load: vi.fn(async (start: number, end: number) => {
      const selected = sorted(start, end);
      const envelope = new HistoryEnvelope(start, end);
      for (const { row } of selected) envelope.add(row);
      return { count: rows.length, rangeCount: selected.length, entries: envelope.points() };
    }),
    tableSnapshot: vi.fn(async (start: number, end: number) => ({ count: sorted(start, end).length, maxKey: rows.length })),
    page: vi.fn(async (start: number, end: number, after: PageCursor | null, size = 50, direction = 'next', maxKey = Infinity) => {
      const reverse = direction === 'prev';
      const ordered = sorted(start, end); if (reverse) ordered.reverse();
      const selected = ordered.filter(({ row, key }) => key <= maxKey && (!after || (reverse ? row.time < after.time || (row.time === after.time && key < after.key) : row.time > after.time || (row.time === after.time && key > after.key))));
      const page = selected.slice(0, size);
      const last = page[page.length - 1];
      return { entries: page.map(({ row }) => row), next: selected.length > size && last ? { time: last.row.time, key: last.key } : null };
    }),
    prune: vi.fn(async (cutoff: number) => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].time < cutoff) rows.splice(i, 1);
    }),
    append: vi.fn(async (row: Co2Measurement) => { rows.push(row); return rows.length; }),
    clear: vi.fn(async () => { rows.length = 0; }), close: vi.fn(async () => {}),
  };
  return { rows, storage, provider: { provide: Co2Storage, useValue: storage } };
}
