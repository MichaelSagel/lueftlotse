import { HistoryEnvelope } from './history-envelope';

describe('Streaming history envelope', () => {
  it('bounds chart memory while preserving minima, maxima and original measurements', () => {
    const envelope = new HistoryEnvelope(0, 100000);
    const original = Array.from({ length: 100000 }, (_, time) => ({ time, ppm: time === 501 ? 200 : time === 502 ? 4000 : 800, segment: 'one' }));
    for (const point of original) envelope.add(point);
    const result = envelope.points();
    expect(result.length).toBeLessThanOrEqual(960);
    expect(Math.min(...result.map(point => point.ppm))).toBe(200);
    expect(Math.max(...result.map(point => point.ppm))).toBe(4000);
    expect(original[501]).toEqual({ time: 501, ppm: 200, segment: 'one' });
  });
  it('never connects across hidden pauses, even when a segment resumes within one bucket', () => {
    const envelope = new HistoryEnvelope(0, 10000, 1);
    envelope.add({ time: 0, ppm: 800, segment: 'a' });
    envelope.add({ time: 1, ppm: 1200, segment: 'b' });
    envelope.add({ time: 2, ppm: 700, segment: 'a' });
    envelope.add({ time: 3, ppm: 900, segment: 'a' });
    const result = envelope.points();
    expect(new Set(result.map(point => point.segment)).size).toBe(result.length);
    expect(result.map(point => point.ppm)).toContain(1200); expect(result.map(point => point.ppm)).toContain(700);
  });
});
