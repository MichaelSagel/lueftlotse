import { concat, crc32, ProtocolError, requireProtocol, Writer } from './binary';
import { decodeBody, encodeBody, isMessageType, logicalSizes, Message, MessageType } from './codec';

export type Direction = 'control' | 'events';
function checkDirection(type: number, direction: Direction): void {
  requireProtocol(direction === 'control' ? type <= 5 : type >= 0x80, 'Wrong GATT direction');
}
function header(type: number, id: number): Uint8Array {
  const writer = new Writer(4); writer.put('u8', 1); writer.put('u8', type); writer.put('u16', id); return writer.bytes;
}
export function fragmentMessage(message: Message, messageId: number, direction: Direction): Uint8Array[] {
  const body = encodeBody(message); checkDirection(message.type, direction);
  if (direction === 'control') requireProtocol(messageId !== 65535, 'Reserved Control ID');
  const prefix = header(message.type, messageId);
  const crc = new Writer(4); crc.put('u32', crc32(concat(prefix, body)));
  const logical = concat(body, crc.bytes); requireProtocol(logical.length <= 128, 'Oversized message');
  const count = Math.ceil(logical.length / 14);
  return Array.from({ length: count }, (_, index) => concat(prefix, Uint8Array.of(index, count), logical.subarray(index * 14, (index + 1) * 14)));
}
export interface DecodedMessage { messageId: number; message: Message; }
interface PartialMessage { type: MessageType; id: number; count: number; next: number; length: number; started: number; bytes: Uint8Array; }
/** One bounded message per direction. reset() is allowed only for a new connection. */
export class FragmentAssembler {
  private partial: PartialMessage | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly seen = new Uint8Array(8192); // All 65536 IDs, constant memory.
  constructor(private readonly direction: Direction, private readonly now: () => number = () => performance.now()) {}
  get bufferedBytes(): number { return this.partial?.length ?? 0; }
  get assembling(): boolean { return this.partial !== undefined; }
  private clearPartial(): void { clearTimeout(this.timer); this.timer = undefined; this.partial = undefined; }
  reset(): void { this.clearPartial(); this.seen.fill(0); }
  dispose(): void { this.reset(); }
  push(frame: Uint8Array): DecodedMessage | null {
    try { return this.accept(frame); } catch (error) { this.clearPartial(); throw error; }
  }
  private accept(frame: Uint8Array): DecodedMessage | null {
    const now = this.now(); requireProtocol(Number.isFinite(now), 'Invalid monotonic clock');
    if (this.partial && (now < this.partial.started || now - this.partial.started >= 5000)) throw new ProtocolError('TIMEOUT', 'Fragment assembly expired');
    if (frame.length < 7 || frame.length > 20) throw new ProtocolError('FRAGMENT_ERROR', 'Invalid ATT length');
    const [version, type] = frame;
    if (version !== 1) throw new ProtocolError('UNSUPPORTED_VERSION', 'Unsupported frame version');
    requireProtocol(isMessageType(type), 'Unknown message type'); checkDirection(type, this.direction);
    const id = frame[2] | frame[3] << 8; const index = frame[4]; const count = frame[5];
    if (this.direction === 'control') requireProtocol(id !== 65535, 'Reserved Control ID');
    const validSizes = logicalSizes(type);
    if (count < 1 || count > 10 || index >= count || !validSizes.some(size => Math.ceil(size / 14) === count) ||
        (index < count - 1 && frame.length !== 20)) throw new ProtocolError('FRAGMENT_ERROR', 'Invalid fragment size/count');
    if (!this.partial) {
      if (index !== 0 || this.seen[id >>> 3] & (1 << (id & 7))) throw new ProtocolError('FRAGMENT_ERROR', 'Unexpected fragment or reused message ID');
      this.seen[id >>> 3] |= 1 << (id & 7);
      this.partial = { type, id, count, next: 0, length: 0, started: now, bytes: new Uint8Array(128) };
      this.timer = setTimeout(() => this.clearPartial(), 5000);
    }
    const p = this.partial;
    if (type !== p.type || id !== p.id || count !== p.count || index !== p.next || p.length + frame.length - 6 > 128) {
      throw new ProtocolError('FRAGMENT_ERROR', 'Out of order/interleaved fragment');
    }
    p.bytes.set(frame.subarray(6), p.length); p.length += frame.length - 6; p.next++;
    if (p.next !== p.count) return null;
    requireProtocol(validSizes.includes(p.length), 'Wrong exact message length');
    const body = p.bytes.subarray(0, p.length - 4);
    const expected = new DataView(p.bytes.buffer).getUint32(p.length - 4, true);
    if (expected !== crc32(concat(header(type, id), body))) throw new ProtocolError('CRC_MISMATCH', 'Corrupted message');
    const message = decodeBody(type, body);
    this.clearPartial(); return { messageId: id, message };
  }
}
