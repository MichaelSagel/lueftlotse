import { Co2Measurement } from '../data-access/co2-storage';

/** Bounded envelope: first/min/max/last per time bucket, never joins hidden pauses. */
export class HistoryEnvelope {
  private readonly buckets = new Map<number, { first: Co2Measurement; last: Co2Measurement; min: Co2Measurement; max: Co2Measurement; mixed: boolean }>();
  constructor(private readonly start: number, private readonly end: number, private readonly size = 240) {}
  add(point: Co2Measurement): void {
    const index = Math.min(this.size - 1, Math.floor((point.time - this.start) / Math.max(1, this.end - this.start) * this.size));
    const bucket = this.buckets.get(index);
    if (!bucket) this.buckets.set(index, { first: point, last: point, min: point, max: point, mixed: false });
    else {
      bucket.mixed ||= bucket.last.segment !== point.segment;
      bucket.last = point;
      if (point.ppm < bucket.min.ppm) bucket.min = point;
      if (point.ppm > bucket.max.ppm) bucket.max = point;
    }
  }
  points(): Co2Measurement[] {
    return [...this.buckets.entries()].sort(([a], [b]) => a - b).flatMap(([index, bucket]) => {
      const points = [...new Set([bucket.first, bucket.min, bucket.max, bucket.last])].sort((a, b) => a.time - b.time);
      return bucket.mixed ? points.map((point, i) => ({ ...point, segment: `gap:${index}:${i}` })) : points;
    });
  }
}
