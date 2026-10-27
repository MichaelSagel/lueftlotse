import { decodeBody, encodeBody, Info, Message } from '../ble-protocol/codec';
import { BatchAck, BatchMessage } from '../ble-protocol/batch-receiver';
import { BatchToken, BleJournalLease, BleStatus, JournalFetch, JournalToken } from './ble-session';

type Command = Extract<Message, { type: 1 | 3 | 4 }>;
export interface JournalTransport {
  readonly info: Info;
  readonly signal: AbortSignal;
  current(): boolean;
  exchange(command: Command, types: readonly number[], signal: AbortSignal, prepared?: (id: number) => void): Promise<Message>;
  listen(receive: (message: Message) => void): () => void;
  close(): Promise<void>;
  release(): void;
}

/** Protocol ownership stays with BleConnection; this bounded lease fences journal commands. */
export class JournalLease implements BleJournalLease {
  readonly info: Info;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private phase: 'idle' | 'status' | 'fetch' | 'received' | 'commit' | 'ack' = 'idle';
  private batch?: { token: BatchToken; begin: Extract<Message, { type: 0x82 }>; end?: Extract<Message, { type: 0x84 }> };
  private unlisten = () => {};
  private deadline?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly detach: (() => void)[] = [];
  private closing?: Promise<void>;
  private closingStarted = false;
  private cause: unknown;

  constructor(readonly token: JournalToken, private readonly transport: JournalTransport, signals: readonly AbortSignal[]) {
    this.info = transport.info;
    for (const signal of [transport.signal, ...signals]) {
      if (signal.aborted) { this.cause = signal.reason; this.revoke(); break; }
      const cancel = () => { if (!this.closingStarted) this.cause = signal.reason; this.revoke(); };
      signal.addEventListener('abort', cancel, { once: true });
      this.detach.push(() => signal.removeEventListener('abort', cancel));
    }
  }
  private owned(): void {
    this.signal.throwIfAborted();
    if (!this.transport.current()) throw new Error('Obsolete journal lease');
  }
  private idle(): void {
    this.owned();
    if (this.phase !== 'idle') throw new Error('Journal operation already in progress');
  }
  async getStatus(): Promise<BleStatus> {
    this.idle(); this.phase = 'status';
    try {
      const status = await this.transport.exchange({ type: 1 }, [0x80], this.signal);
      this.owned(); this.phase = 'idle'; return status as BleStatus;
    } catch (error) { this.cause ??= error; await this.close().catch(() => {}); throw error; }
  }
  async fetch(afterSequence: bigint, limit: number): Promise<JournalFetch> {
    this.idle();
    if ((this.info.capabilities & 0x000a) !== 0x000a) throw new Error('Journal capabilities unavailable');
    if (afterSequence < 0n || afterSequence > 0xffffffffffffffffn || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid FETCH bounds');
    this.phase = 'fetch';
    let requestId = -1;
    const messages: BatchMessage[] = [];
    let complete!: () => void;
    const received = new Promise<void>(resolve => { complete = resolve; });
    this.unlisten = this.transport.listen(message => {
      if (this.signal.aborted || !this.transport.current()) return;
      if (message.type !== 0x82 && message.type !== 0x83 && message.type !== 0x84) return;
      if (this.phase !== 'fetch') throw new Error('Unexpected batch message');
      if (message.type === 0x82) {
        if (this.batch || message.requestId !== requestId || message.afterSequence !== afterSequence || message.count > limit || message.throughSequence <= afterSequence) throw new Error('BATCH_BEGIN does not match FETCH');
        this.batch = { token: Object.freeze({ ...this.token, ticketId: crypto.randomUUID() }), begin: message };
        this.deadline = performance.now() + 30000;
        this.timer = setTimeout(() => { this.cause = new Error('Batch deadline exceeded'); this.revoke(); }, 30000);
      } else {
        if (!this.batch || message.batchId !== this.batch.begin.batchId) throw new Error('Batch entry without matching BEGIN');
        if (message.type === 0x83 && messages.length > this.batch.begin.count) throw new Error('Too many batch entries');
        if (message.type === 0x84) {
          if (messages.length !== this.batch.begin.count + 1) throw new Error('Incomplete batch');
          this.batch.end = message; this.phase = 'received'; complete();
        }
      }
      if (messages.length >= 102) throw new Error('Incoming batch queue full');
      messages.push(message);
    });
    try {
      const first = await this.transport.exchange({ type: 3, afterSequence, limit }, [0x82, 0x85, 0x80], this.signal, id => { requestId = id; });
      this.owned();
      if (first.type !== 0x82) {
        if (this.batch) throw new Error('Conflicting FETCH response');
        this.resetBatch(); this.phase = 'idle';
        return first.type === 0x80 ? { kind: 'status', status: first } : { kind: 'time-pending' };
      }
      await this.wait(received); this.owned();
      // Keep internal metadata private so callers cannot alter the ACK gate.
      return { kind: 'batch', token: this.batch!.token,
        messages: messages.map(message => decodeBody(message.type, encodeBody(message)) as BatchMessage) };
    } catch (error) { this.cause ??= error; await this.close().catch(() => {}); throw error; }
  }
  async commitAndAcknowledge(token: BatchToken, input: BatchAck, commit: () => Promise<void>): Promise<void> {
    this.owned();
    const batch = this.batch;
    if (this.phase !== 'received' || !batch?.end || token.generation !== this.token.generation || token.clientId !== this.token.clientId || token.leaseId !== this.token.leaseId || token.ticketId !== batch.token.ticketId) throw new Error('Obsolete batch token');
    const ack = { ...input, digest: new Uint8Array(input.digest) };
    if (ack.type !== 4 || ack.batchId !== batch.begin.batchId || ack.count !== batch.begin.count || ack.throughSequence !== batch.begin.throughSequence || ack.digest.length !== 32 || !ack.digest.every((byte, i) => byte === batch.end!.digest[i])) throw new Error('ACK does not match batch');
    try {
      if (this.deadline === undefined || performance.now() >= this.deadline) throw new Error('Batch deadline exceeded');
      clearTimeout(this.timer); this.timer = undefined; this.phase = 'commit';
      await this.wait(Promise.resolve().then(() => { this.owned(); return commit(); }));
      this.owned(); this.phase = 'ack';
      const accepted = await this.transport.exchange(ack, [0x87], this.signal);
      this.owned();
      if (accepted.type !== 0x87 || accepted.batchId !== ack.batchId) throw new Error('Wrong ACK_ACCEPTED batchId');
      this.resetBatch(); this.phase = 'idle';
    } catch (error) { this.cause ??= error; await this.close().catch(() => {}); throw error; }
  }
  private wait<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      if (this.signal.aborted) abort();
      else this.signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => this.signal.removeEventListener('abort', abort));
    });
  }
  private resetBatch(): void {
    this.unlisten(); this.unlisten = () => {};
    clearTimeout(this.timer); this.timer = undefined; this.deadline = undefined; this.batch = undefined;
  }
  private detachLease(): void {
    this.controller.abort(this.cause ?? new DOMException('Journal lease revoked', 'AbortError'));
    this.resetBatch(); for (const detach of this.detach.splice(0)) detach();
    this.transport.release();
  }
  revoke(): void {
    if (this.signal.aborted) return;
    if (this.phase !== 'idle') { void this.close().catch(() => {}); return; }
    this.detachLease();
  }
  release(): void { this.revoke(); }
  close(): Promise<void> {
    if (this.closingStarted) return this.closing ?? Promise.resolve();
    if (this.signal.aborted) return Promise.resolve();
    if (!this.transport.current()) { this.detachLease(); return Promise.resolve(); }
    this.closingStarted = true;
    // Start closing before releasing ownership; old cleanup must never target a new lease.
    const close = this.transport.close();
    this.detachLease(); this.closing = close; return close;
  }
}
