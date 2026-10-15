import { concat, Kind, Reader, requireProtocol, Value, widths, Writer } from './binary';

export const GATT = {
  service: '9c6b1000-7a3e-4d9f-8b52-6e210f42a001',
  info: '9c6b1001-7a3e-4d9f-8b52-6e210f42a001',
  control: '9c6b1002-7a3e-4d9f-8b52-6e210f42a001',
  events: '9c6b1003-7a3e-4d9f-8b52-6e210f42a001',
} as const;
const recordFields = { sequence: 'sequence', measurementId: 'uuid', bootId: 'uuid', segmentId: 'uuid', uptimeMs: 'u64' } as const;
const entries = {
  1: { ...recordFields, utcMs: 'utc', ppm: 'ppm' },
  2: { ...recordFields, ppm: 'ppm' },
  3: { fromSequence: 'sequence', toSequence: 'sequence', reason: 'reason' },
} as const;
type Fields<S> = { [K in keyof S]: S[K] extends Kind ? Value<S[K]> : never };
export type Entry = { [T in keyof typeof entries]: { tag: T } & Fields<(typeof entries)[T]> }[keyof typeof entries];
export type ReadyEntry = Extract<Entry, { tag: 1 }>;
const schemas = {
  0x01: {},
  0x02: { bootId: 'uuid', utcMs: 'utc', uncertaintyMs: 'u32' },
  0x03: { afterSequence: 'u64', limit: 'count' },
  0x04: { batchId: 'uuid', throughSequence: 'sequence', count: 'count', digest: 'digest' },
  0x05: { batchId: 'uuid' },
  0x80: { requestId: 'request', bootId: 'uuid', oldest: 'u64', latest: 'u64', overwrittenThrough: 'u64', timeValid: 'bool', firstUndated: 'u64', storageState: 'bool' },
  0x81: { requestId: 'request', bootId: 'uuid', utcMs: 'utc', uptimeMs: 'u64', uncertaintyMs: 'u32' },
  0x82: { requestId: 'request', batchId: 'uuid', afterSequence: 'u64', throughSequence: 'sequence', count: 'count' },
  0x83: { batchId: 'uuid' },
  0x84: { batchId: 'uuid', digest: 'digest' },
  0x85: { requestId: 'request', bootId: 'uuid', firstUndated: 'sequence', latest: 'sequence' },
  0x86: {},
  0x87: { requestId: 'request', batchId: 'uuid' },
  0x88: { fromSequence: 'sequence', toSequence: 'sequence', reason: 'reason' },
  0x89: { requestId: 'request', batchId: 'uuid' },
  0xff: { requestId: 'request', code: 'error' },
} as const;
export type MessageType = keyof typeof schemas;
export type Message = { [T in MessageType]: { type: T } & Fields<(typeof schemas)[T]> &
  (T extends 0x83 ? { entry: Entry } : T extends 0x86 ? { entry: ReadyEntry } : object) }[MessageType];
type Schema = Readonly<Record<string, Kind>>;
const size = (schema: Schema) => Object.values(schema).reduce((total, kind) => total + widths[kind], 0);
function encodeFields(schema: Schema, value: object): Uint8Array {
  const writer = new Writer(size(schema));
  for (const [name, kind] of Object.entries(schema)) writer.put(kind, (value as Record<string, unknown>)[name]);
  return writer.bytes;
}
function decodeFields(schema: Schema, reader: Reader): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).map(([name, kind]) => [name, reader.get(kind)]));
}
export function isMessageType(type: number): type is MessageType { return Object.hasOwn(schemas, type); }
export function logicalSizes(type: MessageType): number[] {
  if (type === 0x83) return [38, 89, 97];
  if (type === 0x86) return [81];
  return [size(schemas[type]) + 4];
}
function checkRange(value: { fromSequence: bigint; toSequence: bigint }): void {
  requireProtocol(value.fromSequence <= value.toSequence, 'Reversed GAP');
}
export function encodeEntry(entry: Entry): Uint8Array {
  requireProtocol(Object.hasOwn(entries, entry.tag), 'Unknown entry tag');
  if (entry.tag === 3) checkRange(entry);
  return concat(Uint8Array.of(entry.tag), encodeFields(entries[entry.tag], entry));
}
export function decodeEntry(bytes: Uint8Array): Entry {
  requireProtocol(bytes.length <= 77, 'Oversized entry');
  const reader = new Reader(bytes); const tag = reader.get('u8');
  requireProtocol(tag === 1 || tag === 2 || tag === 3, 'Unknown entry tag');
  const entry = { tag, ...decodeFields(entries[tag], reader) } as Entry;
  reader.end(); if (entry.tag === 3) checkRange(entry); return entry;
}
function checkMessage(message: Message): void {
  if ('requestId' in message && message.type !== 0x80 && message.type !== 0xff) requireProtocol(message.requestId !== 65535, 'Reserved request ID');
  if (message.type === 0x88) checkRange(message);
  if (message.type === 0x82) requireProtocol(message.afterSequence < message.throughSequence &&
    BigInt(message.count) <= message.throughSequence - message.afterSequence, 'Invalid batch boundaries');
  if (message.type === 0x85) requireProtocol(message.firstUndated <= message.latest, 'Invalid UNDATED bounds');
  if (message.type === 0x80) {
    requireProtocol((message.oldest === 0n && message.latest === 0n) ||
      (message.oldest > 0n && message.oldest <= message.latest), 'Invalid journal bounds');
    requireProtocol(message.overwrittenThrough <= message.latest &&
      (message.overwrittenThrough === 0n || message.overwrittenThrough < message.oldest), 'Invalid overwrite bounds');
    requireProtocol(message.firstUndated === 0n || (message.firstUndated >= message.oldest && message.firstUndated <= message.latest), 'Invalid pending sequence');
  }
  if (message.type === 0x86) requireProtocol(message.entry.tag === 1, 'LIVE requires READY');
}
export function encodeBody(message: Message): Uint8Array {
  requireProtocol(isMessageType(message.type), 'Unknown message type');
  const fields = encodeFields(schemas[message.type], message);
  checkMessage(message);
  if (message.type === 0x83 || message.type === 0x86) return concat(fields, encodeEntry(message.entry));
  return fields;
}
export function decodeBody(type: number, body: Uint8Array): Message {
  requireProtocol(isMessageType(type), 'Unknown message type');
  requireProtocol(logicalSizes(type).includes(body.length + 4), 'Wrong exact body length');
  const reader = new Reader(body); const fields = decodeFields(schemas[type], reader);
  const message = { type, ...fields } as Message;
  if (type === 0x83 || type === 0x86) {
    const entry = decodeEntry(body.subarray(reader.offset));
    const withEntry = { ...message, entry } as Message;
    checkMessage(withEntry); return withEntry;
  }
  reader.end(); checkMessage(message); return message;
}
export function encodeInfo(deviceId: string, capabilities = 15): Uint8Array {
  requireProtocol(Number.isInteger(capabilities) && capabilities >= 0 && capabilities <= 15, 'Unknown capability bits');
  const writer = new Writer(20);
  writer.put('u8', 1); writer.put('u8', 0); writer.put('uuid', deviceId); writer.put('u16', capabilities); return writer.bytes;
}
export function decodeInfo(bytes: Uint8Array): { major: 1; minor: 0; deviceId: string; capabilities: number } {
  requireProtocol(bytes.length === 20, 'Info must be 20 bytes');
  const reader = new Reader(bytes);
  requireProtocol(reader.get('u8') === 1 && reader.get('u8') === 0, 'Unsupported Info version');
  const deviceId = reader.get('uuid'); const capabilities = reader.get('u16');
  requireProtocol((capabilities & ~15) === 0, 'Unknown capability bits');
  reader.end(); return { major: 1, minor: 0, deviceId, capabilities };
}

export interface BatchHeader { batchId: string; afterSequence: bigint; throughSequence: bigint; count: number; }
/** Bounded, validated digest input. No batch state, storage or transport side effects. */
export function canonicalBatchBytes(header: BatchHeader, batch: readonly Entry[]): Uint8Array {
  requireProtocol(batch.length >= 1 && batch.length <= 100 && batch.length === header.count, 'Invalid batch count');
  const bytes = encodeFields({ batchId: 'uuid', afterSequence: 'u64', throughSequence: 'sequence', count: 'count' }, header);
  let next = header.afterSequence + 1n;
  const ids = new Set<string>(); const encoded: Uint8Array[] = [];
  for (const entry of batch) {
    const data = encodeEntry(entry);
    requireProtocol((entry.tag === 3 ? entry.fromSequence : entry.sequence) === next, 'Noncontiguous batch');
    next = (entry.tag === 3 ? entry.toSequence : entry.sequence) + 1n;
    if (entry.tag !== 3) { const id = entry.measurementId.toLowerCase(); requireProtocol(!ids.has(id), 'Duplicate measurement ID'); ids.add(id); }
    encoded.push(data);
  }
  requireProtocol(next - 1n === header.throughSequence, 'Wrong final boundary');
  return concat(new TextEncoder().encode('LL-BATCH-V1\0'), bytes, ...encoded);
}
export async function batchDigest(header: BatchHeader, entries: readonly Entry[]): Promise<Uint8Array> {
  const bytes = canonicalBatchBytes(header, entries);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
