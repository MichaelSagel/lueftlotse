import { afterEach, describe, expect, it } from 'vitest';
import vectors from '../../../../../../docs/test-vectors/ble-live-sample-v1.1.json';
import { concat, crc32 } from './binary';
import { decodeBody, decodeInfo, encodeBody, encodeInfo, Info, LIVE_SAMPLE_CAPABILITY, logicalSizes, Message, supportsLiveSample } from './codec';
import { fragmentMessage, FragmentAssembler } from './fragments';

const bytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], n => parseInt(n, 16));
const hex = (bytes: Uint8Array) => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const id = vectors.liveSampleVectors[0].bootId;
const sample = (v = vectors.liveSampleVectors[1]): Extract<Message, { type: 0x8a }> => ({
  type: 0x8a, bootId: v.bootId, sampleCounter: BigInt(v.sampleCounter), uptimeMs: BigInt(v.uptimeMs), ppm: v.ppm,
});

describe('shared LIVE_SAMPLE v1.1 contract', () => {
  const assemblers: FragmentAssembler[] = [];
  const assembler = (now?: () => number) => {
    const result = new FragmentAssembler('events', now); assemblers.push(result); return result;
  };
  const receive = (frames: Uint8Array[], target = assembler()) => {
    for (const frame of frames.slice(0, -1)) expect(target.push(frame)).toBeNull();
    return target.push(frames[frames.length - 1]);
  };
  afterEach(() => { for (const a of assemblers) a.dispose(); assemblers.length = 0; });

  it('pins the same Info v1.0/v1.1 bytes as the C++ harness', () => {
    expect(LIVE_SAMPLE_CAPABILITY).toBe(0x0010);
    for (const v of vectors.infoVectors) {
      const info: Info = { major: 1, minor: v.minor as 0 | 1, deviceId: id, capabilities: v.capabilities };
      expect(decodeInfo(bytes(v.hex))).toEqual(info);
      expect(hex(encodeInfo(id, v.capabilities, info.minor))).toBe(v.hex);
      expect(supportsLiveSample(info)).toBe(v.minor === 1 && (v.capabilities & 0x0010) !== 0);
    }
    // Existing callers and running firmware keep their v1.0 defaults.
    expect(hex(encodeInfo(id, 0))).toBe(vectors.infoVectors[0].hex);
    expect(hex(encodeInfo(id))).toBe(vectors.infoVectors[1].hex);
  });

  it('checks version-specific capability masks and preview permission independently', () => {
    for (const minor of [0, 1] as const) {
      for (let capabilities = 0; capabilities <= (minor === 0 ? 15 : 31); capabilities++) {
        const info = decodeInfo(encodeInfo(id, capabilities, minor));
        expect(info).toMatchObject({ minor, capabilities });
        expect(supportsLiveSample(info)).toBe(minor === 1 && (capabilities & 16) !== 0);
      }
      for (let bit = minor === 0 ? 4 : 5; bit < 16; bit++) {
        for (const capabilities of [1 << bit, (1 << bit) | 15]) {
          expect(() => encodeInfo(id, capabilities, minor)).toThrow('capability');
          const raw = encodeInfo(id, 0, minor);
          new DataView(raw.buffer).setUint16(18, capabilities, true);
          expect(() => decodeInfo(raw)).toThrow('capability');
          expect(supportsLiveSample({ major: 1, minor, deviceId: id, capabilities })).toBe(false);
        }
      }
    }
    for (const capabilities of [-1, 1.5, NaN, 65536, 2 ** 32 + 16]) {
      expect(() => encodeInfo(id, capabilities, 1)).toThrow();
    }
    for (const [offset, value] of [[0, 0], [0, 2], [1, 2], [1, 255]]) {
      const raw = encodeInfo(id, 16, 1); raw[offset] = value;
      expect(() => decodeInfo(raw)).toThrow('version');
    }
    expect(() => encodeInfo(id, 0, 2 as 1)).toThrow('version');
    for (const badId of [id.replace('4677', '1677'), id.replace('8899', '0899')]) {
      expect(() => encodeInfo(badId, 16, 1)).toThrow('UUID');
      expect(supportsLiveSample({ major: 1, minor: 1, deviceId: badId, capabilities: 16 })).toBe(false);
    }
    for (const length of [0, 19, 21]) expect(() => decodeInfo(new Uint8Array(length))).toThrow('20 bytes');
  });

  it.each(vectors.liveSampleVectors)('pins body, CRC and frames: $name', v => {
    const message = sample(v);
    expect(logicalSizes(0x8a)).toEqual([40]);
    expect(hex(encodeBody(message))).toBe(v.body);
    expect(encodeBody(message)).toHaveLength(36);
    expect(decodeBody(0x8a, bytes(v.body))).toEqual(message);
    const frames = fragmentMessage(message, v.messageId, 'events');
    expect(frames.map(hex)).toEqual(v.frames);
    expect(frames.map(f => f.length)).toEqual([20, 20, 18]);
    expect(hex(concat(...frames.map(f => f.subarray(6))))).toBe(v.logical);
    expect(receive(v.frames.map(bytes))).toEqual({ messageId: v.messageId, message });
    // Canonical READY (0x86) is a different format, never a preview alias.
    expect(() => decodeBody(0x86, bytes(v.body))).toThrow('length');
    expect(() => fragmentMessage(message, v.messageId, 'control')).toThrow('direction');
  });

  it('rejects truncation, trailing bytes, invalid UUIDs, zero counter and invalid ppm', () => {
    const v = vectors.liveSampleVectors[1];
    for (const length of [0, 35, 37, 77, 128]) expect(() => decodeBody(0x8a, new Uint8Array(length))).toThrow('length');
    const invalid: Uint8Array[] = [];
    for (const offset of [6, 8]) { const raw = bytes(v.body); raw[offset] = 0; invalid.push(raw); }
    const zeroCounter = bytes(v.body); zeroCounter.fill(0, 16, 24); invalid.push(zeroCounter);
    for (const ppm of [0, 100001, 0xffffffff]) {
      const raw = bytes(v.body); new DataView(raw.buffer).setUint32(32, ppm, true); invalid.push(raw);
    }
    for (const body of invalid) {
      expect(() => decodeBody(0x8a, body)).toThrow();
      // Recompute valid CRC to ensure rejection is due to fields, not corruption.
      const prefix = bytes(v.frames[0]).subarray(0, 4);
      const checksum = new Uint8Array(4);
      new DataView(checksum.buffer).setUint32(0, crc32(concat(prefix, body)), true);
      const logical = concat(body, checksum);
      const frames = [0, 1, 2].map(i => concat(prefix, Uint8Array.of(i, 3), logical.subarray(i * 14, (i + 1) * 14)));
      expect(() => receive(frames)).toThrow();
    }
    for (const bootId of [id.replace('4677', '1677'), id.replace('8899', '0899')]) {
      expect(() => encodeBody({ ...sample(), bootId })).toThrow('UUID');
    }
    for (const ppm of [0, 100001, 1.5, NaN]) expect(() => encodeBody({ ...sample(), ppm })).toThrow();
  });

  it('keeps uint64 fields as bigint, with no wrap or unsafe Number conversion', () => {
    for (const value of [1n, 9007199254740993n, (1n << 64n) - 1n]) {
      const message = { ...sample(), sampleCounter: value, uptimeMs: value };
      expect(decodeBody(0x8a, encodeBody(message))).toEqual(message);
    }
    expect(decodeBody(0x8a, encodeBody({ ...sample(), uptimeMs: 0n }))).toMatchObject({ uptimeMs: 0n });
    expect(() => encodeBody({ ...sample(), sampleCounter: 0n })).toThrow('counter');
    for (const field of ['sampleCounter', 'uptimeMs'] as const) {
      for (const value of [-1n, 1n << 64n, 9007199254740992, 1]) {
        expect(() => encodeBody({ ...sample(), [field]: value } as Message)).toThrow();
      }
    }
  });

  it('protects every body/CRC byte and the message ID with CRC32', () => {
    const v = vectors.liveSampleVectors[1];
    for (let offset = 0; offset < 40; offset++) {
      const frames = v.frames.map(bytes);
      frames[Math.floor(offset / 14)][6 + offset % 14] ^= 1;
      const a = assembler();
      expect(() => receive(frames, a)).toThrow('Corrupted');
      expect(a.assembling).toBe(false);
      expect(() => a.push(bytes(v.frames[0]))).toThrow('reused');
    }
    const frames = v.frames.map(bytes); frames.forEach(frame => { frame[2] ^= 1; });
    expect(() => receive(frames)).toThrow('Corrupted');
  });

  it('rejects invalid frame lengths/counts, order, major and type', () => {
    const v = vectors.liveSampleVectors[1];
    for (let index = 0; index < 3; index++) {
      for (const delta of [-1, 1]) {
        const frames = v.frames.map(bytes); const original = frames[index];
        frames[index] = delta < 0 ? original.subarray(0, original.length - 1) : concat(original, Uint8Array.of(0));
        expect(() => receive(frames)).toThrow();
      }
    }
    for (const count of [0, 1, 2, 4, 10, 255]) {
      const first = bytes(v.frames[0]); first[5] = count;
      expect(() => assembler().push(first)).toThrow();
    }
    const frames = v.frames.map(bytes);
    expect(() => assembler().push(frames[1])).toThrow();
    for (const next of [frames[0], frames[2], bytes(vectors.liveSampleVectors[0].frames[0])]) {
      const a = assembler(); a.push(frames[0]); expect(() => a.push(next)).toThrow();
    }
    for (const [offset, value] of [[0, 2], [1, 0x8b]]) {
      const first = frames[0].slice(); first[offset] = value;
      expect(() => assembler().push(first)).toThrow();
    }
  });

  it('expires preview fragments and burns message IDs until reconnect', () => {
    let now = 0; const a = assembler(() => now);
    const frames = vectors.liveSampleVectors[2].frames.map(bytes);
    a.push(frames[0]); now = 4999; a.push(frames[1]); now = 5000;
    expect(() => a.push(frames[2])).toThrow('expired');
    expect(() => a.push(frames[0])).toThrow('reused');
    a.reset(); expect(receive(frames, a)?.messageId).toBe(65535);
    expect(() => a.push(frames[0])).toThrow('reused');
    expect(() => fragmentMessage(sample(), 65536, 'events')).toThrow();
  });
});
