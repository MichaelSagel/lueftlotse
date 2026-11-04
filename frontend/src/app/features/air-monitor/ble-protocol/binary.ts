/** Wire primitives: integers are little-endian; UUID bytes follow canonical hex order. */
export class ProtocolError extends Error {
  constructor(readonly code: 'INVALID_MESSAGE' | 'UNSUPPORTED_VERSION' | 'CRC_MISMATCH' | 'FRAGMENT_ERROR' | 'TIMEOUT', message: string) {
    super(message); this.name = 'ProtocolError';
  }
}
export function requireProtocol(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProtocolError('INVALID_MESSAGE', message);
}
export const UTC_MIN_MS = -62135596800000n;
export const UTC_MAX_MS = 253402300799999n;

export type Kind = 'u8' | 'u16' | 'u32' | 'u64' | 'i64' | 'uuid' | 'digest' |
  'sequence' | 'count' | 'ppm' | 'utc' | 'bool' | 'reason' | 'error' | 'request';
export type Value<K extends Kind> = K extends 'uuid' ? string : K extends 'digest' ? Uint8Array :
  K extends 'u64' | 'i64' | 'sequence' | 'utc' ? bigint : number;
export const widths: Record<Kind, number> = {
  u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, uuid: 16, digest: 32,
  sequence: 8, count: 2, ppm: 4, utc: 8, bool: 1, reason: 1, error: 1, request: 2,
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuidBytes(value: string): Uint8Array {
  requireProtocol(typeof value === 'string' && uuidPattern.test(value), 'Expected UUID v4');
  return Uint8Array.from(value.replaceAll('-', '').match(/../g)!, hex => parseInt(hex, 16));
}
function uuidString(bytes: Uint8Array): string {
  const h = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const value = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  uuidBytes(value); return value;
}
function validate(kind: Kind, value: unknown): void {
  if (kind === 'uuid') { uuidBytes(value as string); return; }
  if (kind === 'digest') { requireProtocol(value instanceof Uint8Array && value.length === 32, 'Expected 32-byte digest'); return; }
  if (['u64', 'sequence', 'i64', 'utc'].includes(kind)) {
    requireProtocol(typeof value === 'bigint', '64-bit integer must be bigint');
    const signed = ['i64', 'utc'].includes(kind);
    requireProtocol(value >= (signed ? -(1n << 63n) : 0n) && value <= (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n), '64-bit overflow');
    if (kind === 'sequence') requireProtocol(value > 0n, 'Sequence starts at one');
    if (kind === 'utc') requireProtocol(value >= UTC_MIN_MS && value <= UTC_MAX_MS, 'UTC outside backend range');
    return;
  }
  requireProtocol(typeof value === 'number' && Number.isInteger(value), 'Expected integer');
  const max = widths[kind] === 4 ? 0xffffffff : widths[kind] === 2 ? 65535 : 255;
  requireProtocol(value >= 0 && value <= max, 'Unsigned integer overflow');
  if (kind === 'count') requireProtocol(value >= 1 && value <= 100, 'Count must be 1..100');
  if (kind === 'ppm') requireProtocol(value >= 1 && value <= 100000, 'PPM must be 1..100000');
  if (kind === 'bool') requireProtocol(value <= 1, 'Invalid flag');
  if (kind === 'reason') requireProtocol(value === 1 || value === 2, 'Unknown GAP reason');
  if (kind === 'error') requireProtocol(value >= 1 && value <= 11, 'Unknown error code');
}
export class Writer {
  private offset = 0;
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(size: number) { this.bytes = new Uint8Array(size); this.view = new DataView(this.bytes.buffer); }
  put(kind: Kind, value: unknown): void {
    validate(kind, value);
    const n = widths[kind]; requireProtocol(this.offset + n <= this.bytes.length, 'Write overflow');
    if (kind === 'uuid' || kind === 'digest') this.bytes.set(kind === 'uuid' ? uuidBytes(value as string) : value as Uint8Array, this.offset);
    else if (n === 8) {
      if (['i64', 'utc'].includes(kind)) this.view.setBigInt64(this.offset, value as bigint, true);
      else this.view.setBigUint64(this.offset, value as bigint, true);
    } else if (n === 4) this.view.setUint32(this.offset, value as number, true);
    else if (n === 2) this.view.setUint16(this.offset, value as number, true);
    else this.view.setUint8(this.offset, value as number);
    this.offset += n;
  }
}
export class Reader {
  offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  get<K extends Kind>(kind: K): Value<K> {
    const n = widths[kind]; requireProtocol(this.offset + n <= this.bytes.length, 'Truncated field');
    let value: unknown;
    if (kind === 'uuid') value = uuidString(this.bytes.subarray(this.offset, this.offset + n));
    else if (kind === 'digest') value = this.bytes.slice(this.offset, this.offset + n);
    else if (n === 8) value = ['i64', 'utc'].includes(kind) ? this.view.getBigInt64(this.offset, true) : this.view.getBigUint64(this.offset, true);
    else if (n === 4) value = this.view.getUint32(this.offset, true);
    else if (n === 2) value = this.view.getUint16(this.offset, true);
    else value = this.view.getUint8(this.offset);
    validate(kind, value); this.offset += n; return value as Value<K>;
  }
  end(): void { requireProtocol(this.offset === this.bytes.length, 'Unexpected trailing bytes'); }
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
