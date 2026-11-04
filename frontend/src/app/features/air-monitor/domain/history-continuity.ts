import type { Co2Measurement } from '../data-access/co2-storage';

export function sensorPosition(point: Co2Measurement): { deviceId: string; sequence: bigint } | null {
  if (point.source !== 'sensor' || typeof point.deviceId !== 'string' ||
      typeof point.sequence !== 'string' || !/^[1-9]\d{0,19}$/.test(point.sequence)) return null;
  const sequence = BigInt(point.sequence);
  return sequence <= (1n << 64n) - 1n ? { deviceId: point.deviceId, sequence } : null;
}
/** Chart-only continuity labels before aggregation; original stored segments stay immutable. */
export class HistoryContinuity {
  private previous: { deviceId: string; sequence: bigint; segment: string } | null = null;
  private run = 0;
  constructor(private readonly lost: (deviceId: string, left: bigint, right: bigint) => Promise<boolean>) {}
  async project(point: Co2Measurement): Promise<Co2Measurement> {
    const position = sensorPosition(point);
    if (!position) { this.previous = null; return point; }
    const previous = this.previous;
    if (!previous || previous.deviceId !== position.deviceId || previous.segment !== point.segment ||
        await this.lost(position.deviceId, previous.sequence, position.sequence)) this.run++;
    this.previous = { ...position, segment: point.segment };
    return { ...point, segment: `ble:${position.deviceId}:${point.segment}:${this.run}` };
  }
}
