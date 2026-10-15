import { ReadyEntry, decodeEntry, encodeEntry } from '../ble-protocol/codec';
import { uuidBytes, Writer } from '../ble-protocol/binary';
import type { StoredCo2Measurement } from './co2-storage';

export interface BleReadyBatch {
  readonly deviceId: string;
  readonly afterSequence: bigint;
  readonly throughSequence: bigint;
  readonly entries: readonly ReadyEntry[];
}
export interface SensorCo2Measurement extends StoredCo2Measurement {
  readonly source: 'sensor';
  /** Canonical decimal uint64 strings: IndexedDB keys do not support bigint. */
  readonly sequence: string;
  readonly bootId: string;
  readonly uptimeMs: string;
}
export interface BleImportResult { inserted: number; duplicates: number; cursor: bigint; }
export class BleImportConflictError extends Error {
  constructor() { super('BLE measurement identity conflicts with stored content'); this.name = 'BleImportConflictError'; }
}
export class BleCursorConflictError extends Error {
  constructor() { super('BLE batch does not continue the stored device cursor'); this.name = 'BleCursorConflictError'; }
}
/** Snapshot caller-owned data before the first await. No digest/ACK processing here. */
export function prepareReadyBatch(batch: BleReadyBatch): SensorCo2Measurement[] {
  uuidBytes(batch.deviceId);
  const bounds = new Writer(16); bounds.put('u64', batch.afterSequence); bounds.put('sequence', batch.throughSequence);
  if (batch.entries.length < 1 || batch.entries.length > 100) throw new RangeError('Expected 1..100 READY records');
  let next = batch.afterSequence + 1n;
  const ids = new Set<string>();
  const rows = batch.entries.map(input => {
    const entry = decodeEntry(encodeEntry(input));
    if (entry.tag !== 1 || entry.sequence !== next) throw new BleCursorConflictError();
    next++;
    if (ids.has(entry.measurementId)) throw new BleImportConflictError();
    ids.add(entry.measurementId);
    return {
      measurementId: entry.measurementId, deviceId: batch.deviceId.toLowerCase(), source: 'sensor', syncStatus: 'pending',
      time: Number(entry.utcMs), ppm: entry.ppm, segment: entry.segmentId,
      sequence: entry.sequence.toString(), bootId: entry.bootId, uptimeMs: entry.uptimeMs.toString(),
    } satisfies SensorCo2Measurement;
  });
  if (next - 1n !== batch.throughSequence) throw new BleCursorConflictError();
  return rows;
}
export function sameSensorMeasurement(stored: StoredCo2Measurement, incoming: SensorCo2Measurement): boolean {
  const sensor = stored as Partial<SensorCo2Measurement>;
  return sensor.measurementId === incoming.measurementId && sensor.deviceId === incoming.deviceId &&
    sensor.source === 'sensor' && sensor.time === incoming.time && sensor.ppm === incoming.ppm &&
    sensor.segment === incoming.segment && sensor.sequence === incoming.sequence &&
    sensor.bootId === incoming.bootId && sensor.uptimeMs === incoming.uptimeMs;
}
