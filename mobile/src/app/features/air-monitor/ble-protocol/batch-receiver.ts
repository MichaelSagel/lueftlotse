import { ProtocolError, requireProtocol, uuidBytes } from './binary';
import { batchDigest, decodeBody, encodeBody, Entry, Message } from './codec';
import type { Co2Storage } from '../data-access/co2-storage';

export type BatchMessage = Extract<Message, { type: 0x82 | 0x83 | 0x84 }>;
export type BatchAck = Extract<Message, { type: 4 }>;
export interface BatchTransport { send(message: BatchAck, signal: AbortSignal): Promise<void>; }
interface IncomingBatch {
  begin: Extract<Message, { type: 0x82 }>;
  entries: Entry[];
  ids: Set<string>;
  next: bigint;
  started: number;
  controller: AbortController;
  phase: 'receiving' | 'verifying' | 'committing' | 'ack';
}
/** One instance per connection/device. No native Bluetooth, Angular or UI dependencies. */
export class BatchReceiver {
  private active: IncomingBatch | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private epoch = 0;
  lastError: unknown = null;
  private completionPromise?: Promise<void>;
  private finish?: {resolve: () => void; reject: (error: unknown) => void};
  get completion(): Promise<void> {
    return this.completionPromise ?? Promise.reject(new Error("No batch started"));
  }
  private readonly deviceId: string;
  private readonly stopOnClear: () => void;
  constructor(deviceId: string, private readonly storage: Pick<Co2Storage, 'importBleBatch' | 'onHistoryCleared' | 'historyClearing'>,
    private readonly transport: BatchTransport, private readonly now: () => number = () => performance.now()) {
    uuidBytes(deviceId); this.deviceId = deviceId.toLowerCase();
    this.stopOnClear = storage.onHistoryCleared(() => this.fail(new Error('History cleared')));
  }
  get bufferedEntries(): number { return this.active?.entries.length ?? 0; }
  private release(): void { clearTimeout(this.timer); this.timer = undefined; this.active = undefined; }
  private fail(error: unknown): void {
    this.epoch++; this.lastError = error; this.active?.controller.abort(error); this.finish?.reject(error); this.finish = undefined; this.release();
  }
  disconnect(): void { this.fail(new Error('BLE connection closed')); }
  dispose(): void { this.stopOnClear(); this.disconnect(); }
  async receive(input: BatchMessage): Promise<void> {
    const epoch = this.epoch;
    try { await this.accept(input); } catch (error) { if (this.epoch === epoch) this.fail(error); throw error; }
  }
  private assertActive(batch: IncomingBatch): void {
    batch.controller.signal.throwIfAborted(); requireProtocol(this.active === batch, 'Batch cancelled');
  }
  private checkDeadline(batch: IncomingBatch): void {
    const elapsed = this.now() - batch.started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 30000) throw new ProtocolError('TIMEOUT', 'Batch deadline exceeded');
  }
  private async accept(input: BatchMessage): Promise<void> {
    // Copy mutable caller-owned objects/digests, with exact codec checks, before awaiting.
    const message = decodeBody(input.type, encodeBody(input));
    requireProtocol(message.type === 0x82 || message.type === 0x83 || message.type === 0x84, 'Not a batch message');
    if (message.type === 0x82) {
      requireProtocol(!this.storage.historyClearing, 'History is being cleared');
      requireProtocol(!this.active, 'Another batch is in progress');
      const started = this.now(); requireProtocol(Number.isFinite(started), 'Invalid monotonic clock');
      const batch: IncomingBatch = { begin: message, entries: [], ids: new Set(), next: message.afterSequence + 1n, started, controller: new AbortController(), phase: 'receiving' };
      this.completionPromise = new Promise<void>((resolve,reject) => { this.finish = {resolve,reject}; });
      void this.completionPromise.catch(() => {});
      this.lastError = null; this.active = batch;
      this.timer = setTimeout(() => this.fail(new ProtocolError('TIMEOUT', 'Batch deadline exceeded')), 30000);
      return;
    }
    const batch = this.active;
    requireProtocol(batch && batch.phase === 'receiving', 'No receiving batch');
    this.checkDeadline(batch);
    requireProtocol(message.batchId === batch.begin.batchId, 'Wrong batchId');
    if (message.type === 0x83) {
      requireProtocol(batch.entries.length < batch.begin.count && batch.entries.length < 100, 'Too many batch entries');
      const entry = message.entry;
      const from = entry.tag === 3 ? entry.fromSequence : entry.sequence;
      const to = entry.tag === 3 ? entry.toSequence : entry.sequence;
      requireProtocol(from === batch.next && to <= batch.begin.throughSequence, 'Invalid entry order/bounds');
      if (entry.tag !== 3) { requireProtocol(!batch.ids.has(entry.measurementId), 'Duplicate measurementId'); batch.ids.add(entry.measurementId); }
      batch.next = to + 1n; batch.entries.push(entry); return;
    }
    requireProtocol(batch.entries.length === batch.begin.count && batch.next - 1n === batch.begin.throughSequence, 'Incomplete batch');
    batch.phase = 'verifying';
    const digest = await batchDigest(batch.begin, batch.entries);
    this.assertActive(batch); this.checkDeadline(batch);
    requireProtocol(digest.every((byte, index) => byte === message.digest[index]), 'Batch digest mismatch');
    // The protocol deadline covers reception/verification, not an arbitrary DB timeout.
    clearTimeout(this.timer); this.timer = undefined;
    batch.phase = 'committing';
    await this.storage.importBleBatch({ ...batch.begin, deviceId: this.deviceId, entries: batch.entries, digest }, batch.controller.signal);
    this.assertActive(batch);
    batch.phase = 'ack';
    await this.transport.send({ type: 4, batchId: batch.begin.batchId, throughSequence: batch.begin.throughSequence, count: batch.begin.count, digest }, batch.controller.signal);
    this.assertActive(batch); this.finish?.resolve(); this.finish = undefined; this.release();
  }
}
