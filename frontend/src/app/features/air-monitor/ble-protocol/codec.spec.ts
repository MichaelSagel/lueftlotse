import { describe, expect, it } from 'vitest';
import { crc32, Reader, Writer, UTC_MIN_MS, UTC_MAX_MS } from './binary';
import { batchDigest, canonicalBatchBytes, decodeBody, decodeEntry, decodeInfo, encodeBody, encodeEntry, encodeInfo, Entry, GATT, Message } from './codec';

const id = '00112233-4455-4677-8899-aabbccddeeff';
const uuidHex = '00112233445546778899aabbccddeeff';
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], n => parseInt(n, 16));
const ready: Entry = { tag: 1, sequence: 0x0102030405060708n, measurementId: id, bootId: id, segmentId: id, uptimeMs: (1n << 64n) - 1n, utcMs: -1n, ppm: 100000 };

describe('BLE v1 binary codec', () => {
  it('pins GATT UUIDs and the complete Info wire vector, including canonical UUID byte order', () => {
    expect(GATT).toEqual({ service: '9c6b1000-7a3e-4d9f-8b52-6e210f42a001', info: '9c6b1001-7a3e-4d9f-8b52-6e210f42a001', control: '9c6b1002-7a3e-4d9f-8b52-6e210f42a001', events: '9c6b1003-7a3e-4d9f-8b52-6e210f42a001' });
    const vector = '010000112233445546778899aabbccddeeff0f00';
    expect(hex(encodeInfo(id))).toBe(vector);
    expect(decodeInfo(bytes(vector))).toEqual({ major: 1, minor: 0, deviceId: id, capabilities: 15 });
    for (const index of [0, 1, 18, 19]) { const bad = bytes(vector); bad[index] ^= 0x80; expect(() => decodeInfo(bad)).toThrow(); }
    expect(() => decodeInfo(bytes(vector).subarray(1))).toThrow();
    expect(() => encodeInfo('00112233-4455-1677-8899-aabbccddeeff')).toThrow();
  });
  it('accepts every known capability subset and rejects unknown bits', () => {
    for (let capabilities = 0; capabilities <= 15; capabilities++) expect(decodeInfo(encodeInfo(id, capabilities)).capabilities).toBe(capabilities);
    expect(hex(encodeInfo(id, 0))).toBe('010000112233445546778899aabbccddeeff0000');
    expect(hex(encodeInfo(id, 5))).toBe('010000112233445546778899aabbccddeeff0500');
    for (const bit of [16, 128, 256, 32768]) {
      expect(() => encodeInfo(id, bit)).toThrow();
      const vector = encodeInfo(id); new DataView(vector.buffer).setUint16(18, bit, true); expect(() => decodeInfo(vector)).toThrow();
    }
  });
  it('matches the standard independent CRC-32/ISO-HDLC check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
  it('pins READY, UNDATABLE, GAP and integer byte vectors', () => {
    const vector = '010807060504030201' + uuidHex.repeat(3) + 'ffffffffffffffffffffffffffffffffa0860100';
    expect(hex(encodeEntry(ready))).toBe(vector);
    expect(decodeEntry(bytes(vector))).toEqual(ready);
    const undatable = { tag: 2, sequence: 1n, measurementId: id, bootId: id, segmentId: id, uptimeMs: 2n, ppm: 650 } as const;
    expect(hex(encodeEntry(undatable))).toBe('020100000000000000' + uuidHex.repeat(3) + '02000000000000008a020000');
    expect(hex(encodeEntry({ tag: 3, fromSequence: 1n, toSequence: 3n, reason: 1 }))).toBe('030100000000000000030000000000000001');
    expect(hex(encodeBody({ type: 3, afterSequence: (1n << 64n) - 1n, limit: 100 }))).toBe('ffffffffffffffff6400');
    expect(decodeBody(3, bytes('ffffffffffffffff6400'))).toEqual({ type: 3, afterSequence: (1n << 64n) - 1n, limit: 100 });
  });
  it('preserves signed/unsigned 64-bit boundaries without a number conversion', () => {
    for (const [kind, values] of [['u64', [0n, 9007199254740993n, (1n << 64n) - 1n]], ['i64', [-(1n << 63n), -1n, 0n, (1n << 63n) - 1n]]] as const) {
      for (const value of values) { const writer = new Writer(8); writer.put(kind, value); expect(new Reader(writer.bytes).get(kind)).toBe(value); }
    }
    const signed = new Writer(8); signed.put('i64', -(1n << 63n)); expect(hex(signed.bytes)).toBe('0000000000000080');
    expect(() => new Writer(8).put('i64', 1n << 63n)).toThrow();
    expect(() => new Writer(8).put('u64', -1n)).toThrow();
    expect(() => new Writer(8).put('u64', 1n << 64n)).toThrow();
    expect(() => new Writer(8).put('u64', 9007199254740992)).toThrow();
    for (const utcMs of [UTC_MIN_MS, UTC_MAX_MS]) expect(decodeEntry(encodeEntry({ ...ready, utcMs }))).toEqual({ ...ready, utcMs });
    expect(() => encodeEntry({ ...ready, utcMs: UTC_MAX_MS + 1n })).toThrow();
    for (const utcMs of [UTC_MIN_MS, -1n, 0n, UTC_MAX_MS]) {
      for (const message of [{ type: 2, bootId: id, utcMs, uncertaintyMs: 0 }, { type: 0x81, requestId: 0, bootId: id, utcMs, uptimeMs: 0n, uncertaintyMs: 0 }] as const) expect(decodeBody(message.type, encodeBody(message))).toEqual(message);
    }
    for (const utcMs of [UTC_MIN_MS - 1n, UTC_MAX_MS + 1n]) {
      expect(() => encodeEntry({ ...ready, utcMs })).toThrow();
      expect(() => encodeBody({ type: 2, bootId: id, utcMs, uncertaintyMs: 0 })).toThrow();
      expect(() => encodeBody({ type: 0x81, requestId: 0, bootId: id, utcMs, uptimeMs: 0n, uncertaintyMs: 0 })).toThrow();
      for (const type of [2, 0x81, 0x86] as const) {
        const message = type === 2 ? { type, bootId: id, utcMs: 0n, uncertaintyMs: 0 } as const :
          type === 0x81 ? { type, requestId: 0, bootId: id, utcMs: 0n, uptimeMs: 0n, uncertaintyMs: 0 } as const :
          { type, entry: { ...ready, utcMs: 0n } } as const;
        const raw = encodeBody(message);
        new DataView(raw.buffer).setBigInt64(type === 2 ? 16 : type === 0x81 ? 18 : 65, utcMs, true);
        expect(() => decodeBody(type, raw)).toThrow('UTC');
      }
    }
  });
  it('pins the shared backend UTC endpoint bytes in all three wire formats', () => {
    for (const [utcMs, expected] of [[UTC_MIN_MS, '0028d3ed7cc7ffff'], [UTC_MAX_MS, 'ffdb1fd277e60000']] as const) {
      expect(hex(encodeBody({ type: 2, bootId: id, utcMs, uncertaintyMs: 0 }))).toBe(uuidHex + expected + '00000000');
      expect(hex(encodeBody({ type: 0x81, requestId: 0, bootId: id, utcMs, uptimeMs: 0n, uncertaintyMs: 0 }))).toBe('0000' + uuidHex + expected + '000000000000000000000000');
      expect(hex(encodeEntry({ ...ready, utcMs }))).toBe('010807060504030201' + uuidHex.repeat(3) + 'ffffffffffffffff' + expected + 'a0860100');
    }
    expect(new Date(Number(UTC_MIN_MS)).toISOString()).toBe('0001-01-01T00:00:00.000Z');
    expect(new Date(Number(UTC_MAX_MS)).toISOString()).toBe('9999-12-31T23:59:59.999Z');
    const badBatchId = '00112233-4455-1677-8899-aabbccddeeff';
    expect(() => encodeBody({ type: 5, batchId: badBatchId })).toThrow('UUID v4');
    expect(() => decodeBody(5, bytes('00112233445516778899aabbccddeeff'))).toThrow('UUID v4');
  });
  it('rejects invalid field bounds, tags, flags, exact lengths and message types', () => {
    for (const limit of [0, 101, -1, 1.5, NaN]) expect(() => encodeBody({ type: 3, afterSequence: 0n, limit })).toThrow();
    for (const ppm of [0, 100001, 1.5]) expect(() => encodeEntry({ ...ready, ppm })).toThrow();
    expect(() => encodeEntry({ ...ready, sequence: 0n })).toThrow();
    expect(() => encodeEntry({ tag: 3, fromSequence: 3n, toSequence: 1n, reason: 1 })).toThrow();
    expect(() => decodeEntry(bytes('030100000000000000030000000000000003'))).toThrow();
    expect(() => decodeEntry(Uint8Array.of(0))).toThrow();
    expect(() => decodeBody(6, new Uint8Array())).toThrow();
    expect(() => decodeBody(1, Uint8Array.of(0))).toThrow();
    expect(() => decodeBody(0xff, bytes('ffff00'))).toThrow();
    expect(() => decodeBody(0xff, bytes('ffff0c'))).toThrow();
    for (let code = 1; code <= 11; code++) expect(decodeBody(0xff, Uint8Array.of(255, 255, code))).toEqual({ type: 0xff, requestId: 65535, code });
    expect(() => encodeBody({ type: 0x87, requestId: 65535, batchId: id })).toThrow('Reserved');
    expect(() => decodeBody(0x86, encodeEntry({ tag: 3, fromSequence: 1n, toSequence: 1n, reason: 1 }))).toThrow();
    const status = encodeBody({ type: 0x80, requestId: 65535, bootId: id, oldest: 1n, latest: 3n, overwrittenThrough: 0n, timeValid: 1, firstUndated: 0n, storageState: 0 });
    for (const offset of [42, 51]) { const bad = status.slice(); bad[offset] = 2; expect(() => decodeBody(0x80, bad)).toThrow(); }
  });
  it('pins canonical digest input and SHA-256 from an independent node:crypto reference', async () => {
    const header = { batchId: id, afterSequence: 0n, throughSequence: 3n, count: 1 };
    const entries: Entry[] = [{ tag: 3, fromSequence: 1n, toSequence: 3n, reason: 1 }];
    expect(hex(canonicalBatchBytes(header, entries))).toBe('4c4c2d42415443482d56310000112233445546778899aabbccddeeff000000000000000003000000000000000100030100000000000000030000000000000001');
    expect(hex(await batchDigest(header, entries))).toBe('d0ba1b3f83d9542c29418ebec645a09a893cddfb49eed5db3aee83cfc3fc5802');
    expect(hex(await batchDigest({ ...header, throughSequence: 1n }, [{ ...ready, sequence: 1n, uptimeMs: 0n, utcMs: 1n, ppm: 650 }]))).toBe('6ae3e302286818afe5ee8a4c7c37cb43bfb401b6cf7d2080237db571ca912139');
    expect(() => canonicalBatchBytes(header, [])).toThrow();
    expect(() => canonicalBatchBytes({ ...header, count: 101 }, Array(101).fill(entries[0]))).toThrow();
    expect(() => canonicalBatchBytes({ ...header, throughSequence: 4n }, entries)).toThrow();
    expect(() => canonicalBatchBytes({ ...header, afterSequence: 1n }, entries)).toThrow();
    expect(() => canonicalBatchBytes({ ...header, throughSequence: 2n, count: 2 }, [{ ...ready, sequence: 1n }, { ...ready, sequence: 2n }])).toThrow();
  });
  it('covers exact sizes and decoding for every specified message and entry alternative', () => {
    const digest = new Uint8Array(32);
    const samples: [Message, number][] = [
      [{ type: 1 }, 0], [{ type: 2, bootId: id, utcMs: 1n, uncertaintyMs: 0xffffffff }, 28],
      [{ type: 3, afterSequence: 0n, limit: 100 }, 10], [{ type: 4, batchId: id, throughSequence: 1n, count: 1, digest }, 58],
      [{ type: 5, batchId: id }, 16], [{ type: 0x80, requestId: 65535, bootId: id, oldest: 0n, latest: 0n, overwrittenThrough: 0n, timeValid: 0, firstUndated: 0n, storageState: 1 }, 52],
      [{ type: 0x81, requestId: 0, bootId: id, utcMs: 1n, uptimeMs: 0n, uncertaintyMs: 1 }, 38],
      [{ type: 0x82, requestId: 0, batchId: id, afterSequence: 0n, throughSequence: 1n, count: 1 }, 36],
      [{ type: 0x83, batchId: id, entry: ready }, 93], [{ type: 0x83, batchId: id, entry: { tag: 2, sequence: 1n, measurementId: id, bootId: id, segmentId: id, uptimeMs: 0n, ppm: 1 } }, 85],
      [{ type: 0x83, batchId: id, entry: { tag: 3, fromSequence: 1n, toSequence: 3n, reason: 2 } }, 34],
      [{ type: 0x84, batchId: id, digest }, 48], [{ type: 0x85, requestId: 0, bootId: id, firstUndated: 1n, latest: 3n }, 34],
      [{ type: 0x86, entry: ready }, 77], [{ type: 0x87, requestId: 0, batchId: id }, 18],
      [{ type: 0x88, fromSequence: 1n, toSequence: 3n, reason: 1 }, 17], [{ type: 0x89, requestId: 0, batchId: id }, 18],
      [{ type: 0xff, requestId: 65535, code: 7 }, 3],
    ];
    for (const [message, length] of samples) {
      const encoded = encodeBody(message); expect(encoded.length).toBe(length);
      expect(decodeBody(message.type, encoded)).toEqual(message);
      expect(() => decodeBody(message.type, new Uint8Array(length + 1))).toThrow();
      if (length) expect(() => decodeBody(message.type, encoded.subarray(1))).toThrow();
    }
  });
});
