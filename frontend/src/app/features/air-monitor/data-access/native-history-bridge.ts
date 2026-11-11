import { InjectionToken } from '@angular/core';
import { nativeBindingBridge } from './ble-service-binding-bridge';
import type { HistorySort, ServerMeasurement } from './server-history';

export interface NativeHistoryRequest {
  fromMs: string;
  toMs: string;
  pageSize: number;
  sort: HistorySort;
  deviceId?: string;
  cursor?: string;
}

export interface NativeHistoryBridge {
  getLiveHistory(request: NativeHistoryRequest): Promise<unknown>;
}

interface NativeHistoryRow {
  measurementId: unknown;
  deviceId: unknown;
  bootId: unknown;
  source: unknown;
  ppm: unknown;
  measuredAtMs: unknown;
}

export const NATIVE_HISTORY_BRIDGE = new InjectionToken<NativeHistoryBridge>('NATIVE_HISTORY_BRIDGE', {
  providedIn: 'root',
  // Keep Capacitor's dynamic proxy out of Angular's lifecycle-hook inspection.
  factory: () => ({
    getLiveHistory: request => (nativeBindingBridge as unknown as NativeHistoryBridge).getLiveHistory(request),
  }),
});

/** Calendar receipt milliseconds are exact within Date's range; no sensor uint64 is converted. */
export function nativeHistoryPage(value: unknown): {
  items: ServerMeasurement[];
  nextCursor: string | null;
} {
  const page = value as { items?: unknown; nextCursor?: unknown } | null;
  if (!page || !Array.isArray(page.items) || page.items.length > 50
      || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) {
    throw new Error('Ungültige Antwort des lokalen Speichers.');
  }
  const items = page.items.map((input: unknown) => {
    const row = input as NativeHistoryRow | null;
    if (!row || typeof row.measurementId !== 'string' || typeof row.deviceId !== 'string'
        || typeof row.bootId !== 'string' || row.source !== 'sensor'
        || !Number.isInteger(row.ppm) || (row.ppm as number) < 1 || (row.ppm as number) > 100000
        || typeof row.measuredAtMs !== 'string' || !/^(0|-?[1-9][0-9]{0,15})$/.test(row.measuredAtMs)) {
      throw new Error('Ungültiger Messwert im lokalen Speicher.');
    }
    const time = Number(row.measuredAtMs);
    if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time).getTime())) {
      throw new Error('Ungültige Empfangszeit im lokalen Speicher.');
    }
    const measuredAt = new Date(time).toISOString();
    return {
      measurementId: row.measurementId,
      deviceId: row.deviceId,
      source: row.source,
      measuredAt,
      receivedAt: measuredAt,
      ppm: row.ppm as number,
      segment: row.bootId,
    };
  });
  return { items, nextCursor: page.nextCursor as string | null };
}
