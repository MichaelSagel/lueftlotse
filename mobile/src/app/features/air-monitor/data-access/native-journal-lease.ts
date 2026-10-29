import { PluginListenerHandle } from '@capacitor/core';
import { BatchAck, BatchMessage } from '../ble-protocol/batch-receiver';
import { decodeBody, encodeBody, Info } from '../ble-protocol/codec';
import { uuidBytes } from '../ble-protocol/binary';
import { BatchToken, BleCommandError, BleJournalLease, BleSessionClosedError, BleStatus, JournalFetch, JournalToken } from './ble-session';
import { BleServiceSessionBridge, NativeJournalEvent, NativeJournalReply, NativeJournalToken, nativeAck, nativeMessage, nativeToken, sameNativeToken } from './ble-service-session-bridge';

/** No storage: BatchReceiver supplies a transaction callback, whose completion gates the native ACK. */
export class NativeJournalLease implements BleJournalLease {
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  private readonly initialized: Promise<void>;
  private native?: NativeJournalToken;
  private listener?: PluginListenerHandle;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatPending = false;
  private phase: 'idle' | 'status' | 'fetch' | 'received' | 'commit' | 'ack' = 'idle';
  private collecting?: { operation: string; after: bigint; limit: number; ticket?: string; messages: BatchMessage[]; ended: () => void };
  private batch?: { ticket: string; begin: Extract<BatchMessage, {type: 0x82}>; end: Extract<BatchMessage, {type: 0x84}> };
  private readonly detach: (() => void)[] = [];
  private cleanup?: Promise<void>;
  constructor(readonly token: JournalToken, readonly info: Info, private readonly bridge: BleServiceSessionBridge,
    signals: readonly AbortSignal[], private readonly released: () => void) {
    for (const signal of signals) {
      const stop = () => this.revokeWith(signal.reason);
      if (signal.aborted) stop();
      else { signal.addEventListener('abort', stop, { once: true }); this.detach.push(() => signal.removeEventListener('abort', stop)); }
    }
    this.initialized = this.initialize(); void this.initialized.catch(() => {});
  }
  private async initialize(): Promise<void> {
    try {
      this.signal.throwIfAborted();
      const listener = await this.bridge.addListener('journalEvent', event => this.receive(event));
      if (this.signal.aborted) { await listener.remove(); this.signal.throwIfAborted(); }
      this.listener = listener;
      const acquired = await this.bridge.journalAcquire({ runId: this.token.generation });
      this.native = nativeToken(acquired.token);
      if (this.native.runId !== this.token.generation) throw new Error('Wrong connection generation');
      if (this.signal.aborted) { await this.bridge.journalRevoke({ token: this.native }); this.signal.throwIfAborted(); }
      this.heartbeat = setInterval(() => {
        if (this.heartbeatPending || this.signal.aborted) return;
        this.heartbeatPending = true;
        void this.wait(this.bridge.journalHeartbeat({ token: this.native! }), 4000)
          .catch(error => this.revokeWith(error)).finally(() => { this.heartbeatPending = false; });
      }, 2000);
    } catch (error) { this.revokeWith(error); throw error; }
  }
  private async idle(): Promise<void> {
    await this.wait(this.initialized); this.signal.throwIfAborted();
    if (this.phase !== 'idle') throw new Error('Previous batch/ACK is not finished');
  }
  private reply(input: NativeJournalReply): NativeJournalReply {
    if (input.kind === 'error') {
      const error = nativeMessage(input.message);
      if (error.type !== 0xff) throw new Error('Invalid error response');
      throw new BleCommandError(error.code);
    }
    return input;
  }
  async getStatus(): Promise<BleStatus> {
    await this.idle(); this.phase = 'status';
    try {
      const reply = this.reply(await this.wait(this.bridge.journalStatus({ token: this.native! })));
      const status = nativeMessage(reply.message);
      if (reply.kind !== 'status' || status.type !== 0x80) throw new Error('Expected STATUS');
      this.phase = 'idle'; return status;
    } catch (error) { this.revokeWith(error); throw error; }
  }
  async fetch(afterSequence: bigint, limit: number): Promise<JournalFetch> {
    await this.idle(); encodeBody({ type: 3, afterSequence, limit }); this.phase = 'fetch';
    let ended!: () => void;
    const complete = new Promise<void>(resolve => { ended = resolve; });
    const collecting = { operation: crypto.randomUUID(), after: afterSequence, limit, messages: [] as BatchMessage[], ended };
    this.collecting = collecting;
    try {
      const reply = this.reply(await this.wait(this.bridge.journalFetch({ token: this.native!, operationId: collecting.operation, afterSequence: afterSequence.toString(), limit })));
      if (reply.kind !== 'batch') {
        if (collecting.messages.length) throw new Error('Conflicting FETCH reply');
        this.collecting = undefined; this.phase = 'idle';
        if (reply.kind === 'time-pending') { if (nativeMessage(reply.message).type !== 0x85) throw new Error('Expected TIME_PENDING'); return { kind: 'time-pending' }; }
        const status = nativeMessage(reply.message);
        if (reply.kind !== 'status' || status.type !== 0x80 || status.latest !== afterSequence) throw new Error('Invalid end of journal');
        return { kind: 'status', status };
      }
      await this.wait(complete);
      if (!this.batch || this.batch.ticket !== reply.ticketId) throw new Error('Wrong batch ticket');
      this.collecting = undefined; this.phase = 'received';
      return { kind: 'batch', token: Object.freeze({ ...this.token, ticketId: this.batch.ticket }),
        messages: collecting.messages.map(message => decodeBody(message.type, encodeBody(message)) as BatchMessage) };
    } catch (error) { this.revokeWith(error); throw error; }
  }
  private receive(event: NativeJournalEvent): void {
    if (this.signal.aborted || !this.native || !sameNativeToken(this.native, event.token)) return;
    if (event.kind === 'REVOKED') { this.revokeWith(new BleSessionClosedError(event.reason ?? 'Native journal revoked')); return; }
    const part = this.collecting;
    if (!part || event.operationId !== part.operation) return; // Delayed event from an earlier FETCH.
    try {
      uuidBytes(event.ticketId!);
      if (this.phase !== 'fetch' || part.messages.length >= 102 || this.batch) throw new Error('Unexpected/excessive batch event');
      const message = nativeMessage(event.message);
      if (event.kind === 'BEGIN' && message.type === 0x82) {
        if (part.messages.length || message.afterSequence !== part.after || message.count > part.limit) throw new Error('Wrong BEGIN');
        part.ticket = event.ticketId; part.messages.push(message); return;
      }
      const begin = part.messages[0];
      if (!begin || begin.type !== 0x82 || part.ticket !== event.ticketId || !('batchId' in message) || message.batchId !== begin.batchId) throw new Error('Wrong batch owner');
      if (event.kind === 'ENTRY' && message.type === 0x83) {
        if (part.messages.length > begin.count) throw new Error('Too many entries');
        part.messages.push(message); return;
      }
      if (event.kind !== 'END' || message.type !== 0x84 || part.messages.length !== begin.count + 1) throw new Error('Incomplete batch');
      part.messages.push(message); this.batch = { ticket: part.ticket!, begin, end: message }; part.ended();
    } catch (error) { this.revokeWith(error); }
  }
  async commitAndAcknowledge(token: BatchToken, ack: BatchAck, commit: () => Promise<void>): Promise<void> {
    this.signal.throwIfAborted();
    const batch = this.batch;
    if (this.phase !== 'received' || !batch || token.generation !== this.token.generation || token.clientId !== this.token.clientId ||
        token.leaseId !== this.token.leaseId || token.ticketId !== batch.ticket) throw new Error('Stale batch token');
    const checked = nativeAck(ack);
    if (ack.batchId !== batch.begin.batchId || ack.count !== batch.begin.count || ack.throughSequence !== batch.begin.throughSequence ||
        !ack.digest.every((byte, i) => byte === batch.end.digest[i])) throw new Error('ACK parameters do not match batch');
    this.phase = 'commit';
    const input = { token: this.native!, ticketId: batch.ticket, ack: checked };
    try {
      const prepared = await this.wait(this.bridge.journalBeginCommit(input)); uuidBytes(prepared.commitToken);
      await this.wait(Promise.resolve().then(() => { this.signal.throwIfAborted(); return commit(); }));
      this.signal.throwIfAborted(); this.phase = 'ack';
      const reply = this.reply(await this.wait(this.bridge.journalCommitted({ ...input, commitToken: prepared.commitToken, committed: true })));
      const accepted = nativeMessage(reply.message);
      if (reply.kind !== 'ack-accepted' || accepted.type !== 0x87 || accepted.batchId !== batch.begin.batchId) throw new Error('Wrong ACK_ACCEPTED');
      this.batch = undefined; this.phase = 'idle';
    } catch (error) { this.revokeWith(error); throw error; }
  }
  private wait<T>(operation: Promise<T>, timeout = 35000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(this.signal.reason); };
      const timer = setTimeout(() => this.revokeWith(new Error('Native journal timeout')), timeout);
      if (this.signal.aborted) abort(); else this.signal.addEventListener('abort', abort, { once: true });
      operation.then(value => { cleanup(); this.signal.aborted ? abort() : resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  private revokeWith(reason: unknown): void {
    if (this.signal.aborted) return;
    this.abort.abort(reason); clearInterval(this.heartbeat);
    for (const detach of this.detach.splice(0)) detach();
    this.batch = undefined; this.collecting = undefined;
    // Revocation itself is safe when idle; native closes any exchange with an uncertain outcome.
    this.cleanup = (async () => {
      try { if (this.native) await this.bridge.journalRevoke({ token: this.native }); }
      finally { await this.listener?.remove(); this.released(); }
    })();
    void this.cleanup.catch(() => {});
  }
  revoke(): void { this.revokeWith(new DOMException('Journal revoked', 'AbortError')); }
  release(): void { this.revoke(); }
  close(): Promise<void> { this.revoke(); return this.cleanup ?? Promise.resolve(); }
}
