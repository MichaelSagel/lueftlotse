import { afterEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from './binary';
import { fragmentMessage, FragmentAssembler } from './fragments';

const id = '00112233-4455-4677-8899-aabbccddeeff';
const hex = (value: Uint8Array) => Array.from(value, n => n.toString(16).padStart(2, '0')).join('');
const time = { type: 2, bootId: id, utcMs: 1n, uncertaintyMs: 0xffffffff } as const;
describe('BLE v1 fragment assembly', () => {
  it('pins the STATUS frames shared with firmware vector tests', () => {
    const status = { type: 0x80, requestId: 65535, bootId: id, oldest: 1n, latest: 3n, overwrittenThrough: 0n, timeValid: 1, firstUndated: 0n, storageState: 0 } as const;
    expect(fragmentMessage(status, 7, 'events').map(hex)).toEqual([
      '018007000004ffff00112233445546778899aabb',
      '018007000104ccddeeff01000000000000000300',
      '0180070002040000000000000000000000000000',
      '01800700030401000000000000000000b6f860e2',
    ]);
  });
  const assemblers: FragmentAssembler[] = [];
  const assembler = (now?: () => number) => { const a = new FragmentAssembler('control', now); assemblers.push(a); return a; };
  afterEach(() => { assemblers.forEach(a => a.dispose()); assemblers.length = 0; vi.useRealTimers(); });
  it('pins full header, CRC little-endian and multi-fragment vectors', () => {
    expect(fragmentMessage({ type: 1 }, 0x1234, 'control').map(hex)).toEqual(['010134120001f150a9d0']);
    expect(fragmentMessage({ type: 3, afterSequence: (1n << 64n) - 1n, limit: 100 }, 0, 'control').map(hex)).toEqual(['010300000001ffffffffffffffff64000993a7a2']);
    const frames = fragmentMessage(time, 2, 'control');
    expect(frames.map(hex)).toEqual(['01020200000300112233445546778899aabbccdd', '010202000103eeff0100000000000000ffffffff', '010202000203e59aa7f0']);
    const a = assembler(); expect(a.push(frames[0])).toBeNull(); expect(a.push(frames[1])).toBeNull();
    expect(a.push(frames[2])).toEqual({ messageId: 2, message: time }); expect(a.bufferedBytes).toBe(0);
  });
  it('never emits corrupted CRC, header or body and clears partial state', () => {
    const frame = fragmentMessage({ type: 1 }, 1, 'control')[0];
    for (const offset of [2, 6, 7, 8, 9]) { const a = assembler(); const bad = frame.slice(); bad[offset] ^= 1; expect(() => a.push(bad)).toThrow(); expect(a.bufferedBytes).toBe(0); }
    const a = assembler(); const frames = fragmentMessage(time, 2, 'control');
    a.push(frames[0]); a.push(frames[1]); frames[2][6] ^= 1;
    expect(() => a.push(frames[2])).toThrow('Corrupted'); expect(a.assembling).toBe(false);
  });
  it('rejects an invalid field even when its CRC is correct', () => {
    const frame = fragmentMessage({ type: 3, afterSequence: 0n, limit: 1 }, 0, 'control')[0];
    frame[14] = 0; // limit=0 in the body
    const crcInput = new Uint8Array(14); crcInput.set(frame.subarray(0, 4)); crcInput.set(frame.subarray(6, 16), 4);
    new DataView(frame.buffer).setUint32(16, crc32(crcInput), true);
    expect(() => assembler().push(frame)).toThrow('Count');
  });
  it('rejects omissions, duplicate fragments, interleaving, wrong counts and orphan continuations', () => {
    const frames = fragmentMessage(time, 2, 'control');
    for (const next of [frames[0], frames[2], fragmentMessage(time, 3, 'control')[0]]) {
      const a = assembler(); a.push(frames[0]); expect(() => a.push(next)).toThrow(); expect(a.bufferedBytes).toBe(0);
    }
    expect(() => assembler().push(frames[1])).toThrow();
    for (const count of [0, 1, 2, 4, 10, 255]) { const frame = frames[0].slice(); frame[5] = count; expect(() => assembler().push(frame)).toThrow(); }
    const changed = frames[1].slice(); changed[5] = 4; const a = assembler(); a.push(frames[0]); expect(() => a.push(changed)).toThrow();
  });
  it('enforces frame sizes, version, type, direction and reserved IDs before buffering', () => {
    for (const length of [0, 6, 21, 10000]) expect(() => assembler().push(new Uint8Array(length))).toThrow();
    for (const [offset, value] of [[0, 2], [1, 6], [1, 0xff], [4, 3]] as const) {
      const frame = fragmentMessage(time, 2, 'control')[0]; frame[offset] = value; expect(() => assembler().push(frame)).toThrow();
    }
    expect(() => fragmentMessage(time, 65535, 'control')).toThrow();
    expect(() => fragmentMessage(time, 65536, 'control')).toThrow();
    expect(() => fragmentMessage(time, 1, 'events')).toThrow();
    expect(() => assembler().push(fragmentMessage(time, 2, 'control')[0].subarray(0, 19))).toThrow();
  });
  it('expires at five seconds from first fragment without extending the deadline', () => {
    let now = 100; const a = assembler(() => now); const frames = fragmentMessage(time, 2, 'control');
    a.push(frames[0]); now = 5099; a.push(frames[1]); now = 5100;
    expect(() => a.push(frames[2])).toThrow('expired'); expect(a.bufferedBytes).toBe(0);
  });
  it('releases incomplete memory on the timer even if no further fragment arrives', () => {
    vi.useFakeTimers(); const a = assembler(() => 0); const frames = fragmentMessage(time, 2, 'control');
    a.push(frames[0]); expect(a.bufferedBytes).toBe(14);
    vi.advanceTimersByTime(5000); expect(a.assembling).toBe(false); expect(a.bufferedBytes).toBe(0);
    expect(() => a.push(frames[1])).toThrow();
    expect(() => a.push(frames[0])).toThrow('reused');
  });
  it('tracks ID uniqueness without requiring monotonic IDs and resets only for a new connection', () => {
    const a = assembler(); const first = fragmentMessage({ type: 1 }, 9, 'control')[0];
    a.push(first); expect(() => a.push(first)).toThrow('reused');
    expect(a.push(fragmentMessage({ type: 1 }, 3, 'control')[0])?.messageId).toBe(3);
    a.reset(); expect(a.push(first)?.messageId).toBe(9);
  });
  it('assembles the largest specified message in seven ATT values of at most twenty bytes', () => {
    const message = { type: 0x83, batchId: id, entry: { tag: 1, sequence: 1n, measurementId: id, bootId: id, segmentId: id, uptimeMs: 0n, utcMs: 1n, ppm: 650 } } as const;
    const frames = fragmentMessage(message, 65535, 'events');
    expect(frames).toHaveLength(7); expect(frames.every(frame => frame.length <= 20)).toBe(true);
    const a = new FragmentAssembler('events'); assemblers.push(a);
    for (const frame of frames.slice(0, -1)) expect(a.push(frame)).toBeNull();
    expect(a.push(frames[6])).toEqual({ messageId: 65535, message });
  });
  it('keeps phone and ESP32 ID namespaces independent and retries failures with a fresh ID', () => {
    const control = assembler(); const events = new FragmentAssembler('events'); assemblers.push(events);
    const request = fragmentMessage({ type: 1 }, 7, 'control')[0];
    expect(control.push(request)?.messageId).toBe(7);
    const response = fragmentMessage({ type: 0xff, requestId: 7, code: 3 }, 7, 'events')[0];
    expect(events.push(response)?.messageId).toBe(7);
    const failed = fragmentMessage({ type: 1 }, 8, 'control')[0]; failed[6] ^= 1;
    expect(() => control.push(failed)).toThrow();
    expect(() => control.push(fragmentMessage({ type: 1 }, 8, 'control')[0])).toThrow('reused');
    expect(control.push(fragmentMessage({ type: 1 }, 9, 'control')[0])?.messageId).toBe(9);
  });
  it('requires a new connection after exhausting either direction without wrapping IDs', () => {
    const control = assembler(); const events = new FragmentAssembler('events'); assemblers.push(events);
    for (let messageId = 0; messageId < 65535; messageId++) control.push(fragmentMessage({ type: 1 }, messageId, 'control')[0]);
    for (let messageId = 0; messageId <= 65535; messageId++) events.push(fragmentMessage({ type: 0xff, requestId: 65535, code: 7 }, messageId, 'events')[0]);
    expect(() => control.push(fragmentMessage({ type: 1 }, 0, 'control')[0])).toThrow('reused');
    expect(() => fragmentMessage({ type: 1 }, 65535, 'control')).toThrow('Reserved');
    expect(() => events.push(fragmentMessage({ type: 0xff, requestId: 65535, code: 7 }, 0, 'events')[0])).toThrow('reused');
    expect(() => fragmentMessage({ type: 0xff, requestId: 65535, code: 7 }, 65536, 'events')).toThrow();
    control.reset(); events.reset();
    expect(control.push(fragmentMessage({ type: 1 }, 0, 'control')[0])?.messageId).toBe(0);
    expect(events.push(fragmentMessage({ type: 0xff, requestId: 65535, code: 7 }, 0, 'events')[0])?.messageId).toBe(0);
  }, 15000);
});
