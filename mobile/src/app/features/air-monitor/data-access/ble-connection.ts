import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { decodeInfo, Message, supportsLiveSample } from '../ble-protocol/codec';
import { FragmentAssembler, fragmentMessage } from '../ble-protocol/fragments';
import { BLE_ADAPTER } from './ble-adapter';
import { BleScanner } from './ble-scanner';

type Status = Extract<Message, { type: 0x80 }>;
type Info = ReturnType<typeof decodeInfo>;
export type LiveSample = Extract<Message, { type: 0x8a }>;
export type PreviewEvent = { kind: 'ready' } | { kind: 'unavailable' } | { kind: 'sample'; sample: LiveSample };
export type JournalCommand = Extract<Message, {type: 1 | 3 | 4}>;
export class BleCommandError extends Error {
  constructor(readonly code: number) { super('BLE protocol error ' + code); }
}
export interface BleJournalLink {
  readonly info: Info;
  readonly signal: AbortSignal;
  request(command: JournalCommand, types: readonly number[], signal: AbortSignal, prepared?: (id: number) => void): Promise<Message>;
  listen(receive: (message: Message) => void): () => void;
  close(): Promise<void>;
  release(): void;
}
interface Request {
  types: readonly number[];
  resolve: (message: Message) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Session {
  id: string;
  abort: AbortController;
  assembler: FragmentAssembler;
  pending: Set<Promise<unknown>>;
  connecting: boolean;
  subscribed: boolean;
  nextId: number;
  queued: number;
  tail: Promise<void>;
  requests: Map<number, Request>;
  writeTail: Promise<void>;
  listeners: Set<(message: Message) => void>;
  leased: boolean;
  exchanges: number;
  bootId?: string;
  sampleCounter?: bigint;
  uptimeMs?: bigint;
  cleanup?: Promise<void>;
  closing?: Promise<void>;
}

/** One Events assembler/session for handshake, manual journal requests and volatile preview. */
@Injectable()
export class BleConnection {
  private readonly adapter = inject(BLE_ADAPTER);
  private readonly scanner = inject(BleScanner);
  private readonly document = inject(DOCUMENT);
  readonly state = signal<'idle' | 'connecting' | 'ready' | 'closing' | 'error'>('idle');
  readonly phase = signal<'idle' | 'scan-stop' | 'initialize' | 'connect' | 'info' | 'subscribe' | 'status' | 'ready' | 'closing' | 'error'>('idle');
  readonly info = signal<Info | null>(null);
  readonly status = signal<Status | null>(null);
  readonly error = signal<string | null>(null);
  private readonly preview = new Subject<PreviewEvent>();
  /** No replay/cache: selecting Sensor always waits for a NEW valid notification. */
  readonly previewEvents = this.preview.asObservable();
  private session?: Session;
  private destroyed = false;
  private readonly background = () => { if (this.document.hidden) void this.disconnect().catch(() => {}); };

  constructor() {
    this.document.addEventListener('visibilitychange', this.background);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.document.removeEventListener('visibilitychange', this.background);
      void this.disconnect().catch(() => {});
      this.preview.complete();
    });
  }

  async connect(id: string, signal?: AbortSignal): Promise<Status> {
    if (!this.adapter.available()) throw new Error('BLE is available only in the Android app');
    if (this.destroyed || this.document.hidden || this.session || !id) throw new Error('BLE session unavailable');
    signal?.throwIfAborted();
    const session: Session = { id, abort: new AbortController(), assembler: new FragmentAssembler('events'),
      pending: new Set(), connecting: false, subscribed: false, nextId: 0, queued: 0, tail: Promise.resolve(), requests: new Map(), writeTail: Promise.resolve(), listeners: new Set(), leased: false, exchanges: 0 };
    this.session = session; this.info.set(null); this.status.set(null); this.error.set(null); this.state.set('connecting');
    this.preview.next({ kind: 'unavailable' });
    const cancel = () => { void this.close(session, signal?.reason ?? new Error('Cancelled')).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.assertCurrent(session); this.phase.set('scan-stop');
      await this.operation(session, () => this.scanner.stop(), 15000);
      this.assertCurrent(session); this.phase.set('initialize');
      await this.operation(session, () => this.adapter.initialize(), 10000);
      this.assertCurrent(session); this.phase.set('connect');
      session.connecting = true;
      await this.operation(session, () => this.adapter.connect(id, () => {
        if (this.current(session)) void this.close(session, new Error('BLE disconnected')).catch(() => {});
      }), 10000);
      this.assertCurrent(session); this.phase.set('info');
      const value = await this.operation(session, () => this.adapter.readInfo(id));
      this.assertCurrent(session);
      if (value.byteLength !== 20) throw new Error('Info must be 20 bytes');
      const info = decodeInfo(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      this.info.set(info);
      this.assertCurrent(session); this.phase.set('subscribe');
      session.subscribed = true; // Also clean up a subscription whose Promise completes late or fails.
      await this.operation(session, () => this.adapter.subscribe(id, value => this.receive(session, value)));
      this.assertCurrent(session); this.phase.set('status');
      const status = await this.enqueueStatus(session);
      this.assertCurrent(session); session.bootId = status.bootId; this.status.set(status);
      this.phase.set('ready'); this.state.set('ready');
      this.preview.next({ kind: 'ready' }); return status;
    } catch (error) {
      void this.close(session, error).catch(() => {});
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  getStatus(): Promise<Status> {
    const session = this.session;
    if (!session || session.leased || this.state() !== 'ready') return Promise.reject(new Error('BLE is not ready'));
    return this.enqueueStatus(session);
  }

  /** Exclusive ownership of journal requests; no generic raw writes escape this session. */
  journal(): BleJournalLink {
    const session = this.session; const info = this.info();
    if (!session || !info || session.leased || session.queued || this.state() !== 'ready') throw new Error('BLE journal unavailable');
    session.leased = true;
    let released = false;
    const owned = () => { this.assertCurrent(session); if (released) throw new Error('Journal released'); };
    return {
      info, signal: session.abort.signal,
      request: (command, types, signal, prepared) => { owned(); return this.exchange(session, command, types, signal, prepared); },
      listen: receive => { owned(); session.listeners.add(receive); return () => session.listeners.delete(receive); },
      close: () => this.close(session),
      release: () => { released = true; session.leased = false; },
    };
  }

  disconnect(): Promise<void> {
    return this.session ? this.close(this.session) : Promise.resolve();
  }

  private current(session: Session): boolean { return this.session === session && !session.abort.signal.aborted; }
  private assertCurrent(session: Session): void {
    session.abort.signal.throwIfAborted();
    if (this.session !== session) throw new Error('Obsolete BLE session');
  }

  /** Bound caller wait; retain native work so late connect/subscribe is drained before reuse. */
  private operation<T>(session: Session, run: () => Promise<T>, timeout = 5000): Promise<T> {
    this.assertCurrent(session);
    const native = Promise.resolve().then(() => { this.assertCurrent(session); return run(); });
    session.pending.add(native);
    void native.then(() => session.pending.delete(native), () => session.pending.delete(native));
    return new Promise<T>((resolve, reject) => {
      const abort = () => finish(() => reject(session.abort.signal.reason));
      const timer = setTimeout(() => finish(() => reject(new Error('BLE operation timed out'))), timeout);
      const finish = (complete: () => void) => {
        clearTimeout(timer); session.abort.signal.removeEventListener('abort', abort); complete();
      };
      session.abort.signal.addEventListener('abort', abort, { once: true });
      native.then(value => finish(() => {
        try { this.assertCurrent(session); resolve(value); } catch (error) { reject(error); }
      }), error => finish(() => reject(error)));
    });
  }

  private enqueueStatus(session: Session): Promise<Status> {
    if (session.queued >= 4) return Promise.reject(new Error('BLE command queue full'));
    session.queued++;
    const result = session.tail.then(() => this.exchange(session, {type: 1}, [0x80], session.abort.signal) as Promise<Status>);
    session.tail = result.then(() => {}, error => { void this.close(session, error).catch(() => {}); });
    return result.finally(() => { session.queued--; });
  }

  /** Only writes occupy writeTail. Waiting for a FETCH result never blocks its ACK. */
  private exchange(session: Session, command: JournalCommand, types: readonly number[], signal: AbortSignal, prepared?: (id: number) => void): Promise<Message> {
    try { this.assertCurrent(session); signal.throwIfAborted(); } catch(error) { return Promise.reject(error); }
    if (session.exchanges >= 4) return Promise.reject(new Error('BLE command queue full'));
    if (session.nextId > 65534) {
      const error = new Error('BLE message IDs exhausted; reconnect required');
      void this.close(session, error).catch(() => {}); return Promise.reject(error);
    }
    session.exchanges++;
    const id = session.nextId++;
    let request!: Request;
    const response = new Promise<Message>((resolve,reject) => { request = {types,resolve,reject}; });
    session.requests.set(id,request); void response.catch(() => {});
    const abort = () => request.reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    const write = session.writeTail.then(async () => {
      this.assertCurrent(session); signal.throwIfAborted(); prepared?.(id);
      for (const frame of fragmentMessage(command,id,'control')) {
        signal.throwIfAborted();
        await this.operation(session, () => this.adapter.write(session.id,new DataView(frame.buffer,frame.byteOffset,frame.byteLength)));
      }
      if (session.requests.has(id)) request.timer = setTimeout(() => request.reject(new Error('STATUS/command timed out')),5000);
    });
    session.writeTail = write.then(() => {}, () => {});
    void write.catch(error => request.reject(error));
    return (async () => {
      try {
        // Observe abort/errors immediately, including while an uncancellable write is pending.
        const result = await response;
        await write; this.assertCurrent(session); signal.throwIfAborted(); return result;
      } finally {
        session.exchanges--; clearTimeout(request.timer); session.requests.delete(id); signal.removeEventListener('abort',abort);
      }
    })();
  }

  private receive(session: Session, value: DataView): void {
    if (!this.current(session)) return;
    try {
      if (value.byteLength < 7 || value.byteLength > 20) throw new Error('Invalid Events ATT length');
      const decoded = session.assembler.push(new Uint8Array(value.buffer,value.byteOffset,value.byteLength).slice());
      if (!decoded) return;
      const message = decoded.message;
      if (message.type === 0x8a) {
        const info = this.info();
        if (this.state() !== 'ready' || !info || !supportsLiveSample(info) || message.bootId !== session.bootId) return;
        if (session.sampleCounter !== undefined && message.sampleCounter <= session.sampleCounter) return;
        if (session.uptimeMs !== undefined && message.uptimeMs < session.uptimeMs) return;
        session.sampleCounter = message.sampleCounter; session.uptimeMs = message.uptimeMs;
        this.preview.next({ kind: 'sample', sample: message });
        return; // Never forward preview to journal listeners or persistence.
      }
      const request = 'requestId' in message ? session.requests.get(message.requestId) : undefined;
      if (message.type === 0x80 && (message.requestId === 65535 || request?.types.includes(0x80))) {
        if (session.bootId && message.bootId !== session.bootId) throw new Error('STATUS bootId changed; reconnect required');
        this.status.set(message);
      }
      for (const listener of session.listeners) listener(message);
      if (message.type === 0xff) {
        const error = new BleCommandError(message.code);
        if (request) { clearTimeout(request.timer); request.reject(error); session.requests.delete(message.requestId); }
        else if (message.requestId === 65535) throw error;
      } else if (request && request.types.includes(message.type)) {
        clearTimeout(request.timer); request.resolve(message); session.requests.delete(('requestId' in message) ? message.requestId : -1);
      }
    } catch(error) { void this.close(session,error).catch(() => {}); }
  }

  private close(session: Session, reason?: unknown): Promise<void> {
    if (session.closing) return session.closing;
    this.phase.set('closing');
    session.abort.abort(reason ?? new Error('BLE session closed'));
    session.assembler.dispose();
    for (const request of session.requests.values()) { clearTimeout(request.timer); request.reject(session.abort.signal.reason); }
    session.requests.clear(); session.listeners.clear();
    if (reason) { this.error.set(reason instanceof Error ? reason.message : String(reason)); this.state.set('error'); }
    else this.state.set('closing');
    this.preview.next({ kind: 'unavailable' });
    session.cleanup = (async () => {
      // Keep the slot reserved until uncancellable native operations settle. Never let old cleanup affect a new session.
      await Promise.allSettled([...session.pending]);
      const errors: unknown[] = [];
      for (const action of [
        () => session.subscribed ? this.adapter.unsubscribe(session.id) : Promise.resolve(),
        () => session.connecting ? this.adapter.disconnect(session.id) : Promise.resolve(),
      ]) {
        try { await this.cleanupOperation(action); } catch (error) { errors.push(error); }
      }
      if (errors.length) {
        this.error.set('BLE cleanup failed; session cannot be reused'); this.phase.set('error'); this.state.set('error');
        throw new Error('BLE cleanup failed');
      }
      if (this.session === session) { this.session = undefined; this.phase.set('idle'); this.info.set(null); this.status.set(null); if (!reason) this.state.set('idle'); }
    })();
    // disconnect has a finite wait even if an adapter fails to settle; slot remains quarantined.
    session.closing = this.cleanupOperation(() => session.cleanup!);
    return session.closing;
  }

  private cleanupOperation<T>(action: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('BLE cleanup timed out')), 10000);
      Promise.resolve().then(action).then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }
}
