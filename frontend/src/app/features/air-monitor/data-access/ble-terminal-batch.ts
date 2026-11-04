import { BatchHeader, Entry, canonicalBatchBytes, decodeEntry, encodeEntry } from '../ble-protocol/codec';
import { uuidBytes } from '../ble-protocol/binary';
import { prepareReadyBatch, SensorCo2Measurement } from './ble-ready-batch';

export interface VerifiedBleBatch extends BatchHeader { deviceId: string; entries: readonly Entry[]; digest: Uint8Array; }
/** Calendar anniversary in local time; February 29 clamps to February 28. */
export function serviceRecordExpired(receivedAt: number, now: number): boolean {
  const expires = new Date(receivedAt); const month = expires.getMonth();
  expires.setFullYear(expires.getFullYear() + 2);
  if (expires.getMonth() !== month) expires.setDate(0);
  return expires.getTime() < now; // Preserve the exact retention boundary.
}
export type TerminalRecord =
  | { kind: 'ready'; row: SensorCo2Measurement }
  | { kind: 'undatable'; row: { deviceId: string; measurementId: string; sequence: string; bootId: string; segment: string; uptimeMs: string; ppm: number } }
  | { kind: 'gap'; row: { deviceId: string; fromSequence: string; toSequence: string; reason: number } };
export function prepareTerminalBatch(batch: VerifiedBleBatch): TerminalRecord[] {
  uuidBytes(batch.deviceId); canonicalBatchBytes(batch, batch.entries);
  if (!(batch.digest instanceof Uint8Array) || batch.digest.length !== 32) throw new Error('Invalid batch digest size');
  const deviceId = batch.deviceId.toLowerCase();
  return batch.entries.map(input => {
    const entry = decodeEntry(encodeEntry(input));
    if (entry.tag === 1) return { kind: 'ready', row: prepareReadyBatch({ deviceId, afterSequence: entry.sequence - 1n, throughSequence: entry.sequence, entries: [entry] })[0] };
    if (entry.tag === 2) return { kind: 'undatable', row: { deviceId, measurementId: entry.measurementId, sequence: entry.sequence.toString(), bootId: entry.bootId, segment: entry.segmentId, uptimeMs: entry.uptimeMs.toString(), ppm: entry.ppm } };
    return { kind: 'gap', row: { deviceId, fromSequence: entry.fromSequence.toString(), toSequence: entry.toSequence.toString(), reason: entry.reason } };
  });
}
