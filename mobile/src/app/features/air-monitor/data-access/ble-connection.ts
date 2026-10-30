import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { decodeInfo, Message, supportsLiveSample } from '../ble-protocol/codec';
import { FragmentAssembler, fragmentMessage } from '../ble-protocol/fragments';
import { BLE_ADAPTER } from './ble-adapter';
import { BleScanner } from './ble-scanner';
import { BleBindingStore } from './ble-binding';
import { BleCommandError, BleJournalLease, BleSession, BleSessionClient, BleSessionClosedError, BleStatus, PreviewEvent } from './ble-session';
import { JournalLease } from './ble-journal-lease';

export const BLE_SCAN_BARRIER = new InjectionToken<Pick<BleScanner, 'stop'>>('BLE_SCAN_BARRIER', { providedIn: 'root', factory: () => inject(BleScanner) });
export const BLE_CONNECTION_BINDING = new InjectionToken<Pick<BleBindingStore, 'saved' | 'error' | 'loading' | 'ready' | 'assertIdentity' | 'remember' | 'disableConnection' | 'forget'>>('BLE_CONNECTION_BINDING', { providedIn: 'root', factory: () => inject(BleBindingStore) });

type Status = BleStatus;
type Info = ReturnType<typeof decodeInfo>;
type JournalCommand = Extract<Message, {type: 1 | 3 | 4}>;
interface Request {
  types: readonly number[];
  resolve: (message: Message) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Session {
  id: string;
  generation: string;
  abort: AbortController;
  assembler: FragmentAssembler;
  pending: Set<Promise<unknown>>;
  connecting: boolean;
  subscribed: boolean;
  nextId: number;
  queued: number;
  statusTail: Promise<void>;
  requests: Map<number, Request>;
  controlTail: Promise<void>;
  listeners: Set<(message: Message) => void>;
  lease?: string;
  exchanges: number;
  bootId?: string;
  sampleCounter?: bigint;
  uptimeMs?: bigint;
  cleanup?: Promise<void>;
  closing?: Promise<void>;
}

/** One Events assembler/session for handshake, manual journal requests and volatile preview. */
@Injectable()
export class BleConnection implements BleSession {
  private readonly adapter = inject(BLE_ADAPTER);
  private readonly scanner = inject(BLE_SCAN_BARRIER);
  private readonly document = inject(DOCUMENT);
  private readonly bindings = inject(BLE_CONNECTION_BINDING);
  readonly binding = this.bindings.saved;
  readonly bindingError = this.bindings.error;
  readonly bindingLoading = this.bindings.loading;
  private bindingChanges = 0;
  readonly state = signal<'idle' | 'connecting' | 'ready' | 'closing' | 'error'>('idle');
  readonly phase = signal<'idle' | 'scan-stop' | 'initialize' | 'connect' | 'info' | 'subscribe' | 'status' | 'ready' | 'closing' | 'error'>('idle');
  readonly info = signal<Info | null>(null);
  readonly status = signal<Status | null>(null);
  readonly error = signal<string | null>(null);
  private readonly preview = new Subject<PreviewEvent>();
  /** No replay/cache: the Sensor display waits for a NEW valid notification. */
  readonly previewEvents = this.preview.asObservable();
  private session?: Session;
  private generation = 0n;
  private readonly clients = new Set<AbortController>();
  private destroyed = false;
  private readonly background = () => this.visibilityChanged(this.document.hidden);

  protected visibilityChanged(hidden: boolean): void {
    if (hidden) void this.disconnect().catch(() => {});
  }
  protected previewExpired(): void { this.preview.next({ kind: 'unavailable', reason: 'stale' }); }

  constructor() {
    this.document.addEventListener('visibilitychange', this.background);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      for (const client of this.clients) client.abort(new Error('BLE client destroyed'));
      this.clients.clear();
      this.document.removeEventListener('visibilitychange', this.background);
      void this.disconnect().catch(() => {});
      this.preview.complete();
    });
  }

  async connect(id: string, signal?: AbortSignal): Promise<Status> {
    if (!this.adapter.available()) throw new Error('BLE is available only in the Android app');
    if (this.destroyed || this.document.hidden || this.session || this.bindingChanges || !id) throw new Error('BLE session unavailable');
    signal?.throwIfAborted();
    const session: Session = { id, generation: (++this.generation).toString(), abort: new AbortController(), assembler: new FragmentAssembler('events'),
      pending: new Set(), connecting: false, subscribed: false, nextId: 0, queued: 0, statusTail: Promise.resolve(), requests: new Map(), controlTail: Promise.resolve(), listeners: new Set(), exchanges: 0 };
    this.session = session; this.info.set(null); this.status.set(null); this.error.set(null); this.state.set('connecting');
    this.preview.next({ kind: 'unavailable' });
    const cancel = () => { void this.close(session, signal?.reason ?? new Error('Cancelled')).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.assertCurrent(session); this.phase.set('scan-stop');
      await this.operation(session, () => this.scanner.stop(), 15000);
      this.assertCurrent(session); this.phase.set('initialize');
      await this.operation(session, () => this.bindings.ready());
      await this.operation(session, () => this.adapter.initialize(), 10000);
      this.assertCurrent(session); this.phase.set('connect');
      session.connecting = true;
      await this.operation(session, () => this.adapter.connect(id, () => {
        if (this.current(session)) void this.close(session, new BleSessionClosedError('BLE disconnected')).catch(() => {});
      }), 10000);
      this.assertCurrent(session); this.phase.set('info');
      const value = await this.operation(session, () => this.adapter.readInfo(id));
      this.assertCurrent(session);
      if (value.byteLength !== 20) throw new Error('Info must be 20 bytes');
      const info = decodeInfo(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      this.bindings.assertIdentity(info.deviceId);
      this.info.set(info);
      this.assertCurrent(session); this.phase.set('subscribe');
      session.subscribed = true; // Also clean up a subscription whose Promise completes late or fails.
      await this.operation(session, () => this.adapter.subscribe(id, value => this.receive(session, value)));
      this.assertCurrent(session); this.phase.set('status');
      const status = await this.enqueueStatus(session);
      this.assertCurrent(session); session.bootId = status.bootId;
      await this.operation(session, () => this.bindings.remember(info.deviceId, id, session.abort.signal));
      this.assertCurrent(session); this.status.set(status);
      this.phase.set('ready'); this.state.set('ready');
      this.preview.next({ kind: 'ready' }); return status;
    } catch (error) {
      void this.close(session, error).catch(() => {});
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  getStatus(): Promise<Status> {
    const session = this.session;
    if (!session || session.lease || this.state() !== 'ready') return Promise.reject(new Error('BLE is not ready'));
    return this.enqueueStatus(session);
  }

  attachClient(): BleSessionClient {
    if (this.destroyed) throw new Error('BLE session destroyed');
    const controller = new AbortController(); const id = crypto.randomUUID();
    this.clients.add(controller);
    const owned = () => { controller.signal.throwIfAborted(); if (this.destroyed) throw new Error('BLE session destroyed'); };
    const command = async <T>(run: () => Promise<T>): Promise<T> => {
      owned(); const result = await run(); owned(); return result;
    };
    return {
      id, signal: controller.signal,
      connect: address => command(() => this.connect(address, controller.signal)),
      disconnect: () => command(() => this.disconnect()),
      disconnectByUser: () => command(() => this.disconnectByUser()),
      forgetDevice: () => command(() => this.forgetDevice()),
      journal: signal => { owned(); return this.journal(id, controller.signal, signal); },
      revoke: () => { controller.abort(new DOMException('BLE client revoked', 'AbortError')); this.clients.delete(controller); },
    };
  }

  /** A lease is a capability on this connection, never another GATT session. */
  private journal(clientId: string, clientSignal: AbortSignal, signal?: AbortSignal): BleJournalLease {
    const session = this.session; const info = this.info();
    signal?.throwIfAborted();
    if (!session || !info || session.lease || session.queued || this.state() !== 'ready') throw new Error('BLE journal unavailable');
    const leaseId = crypto.randomUUID(); session.lease = leaseId;
    const current = () => this.current(session) && session.lease === leaseId;
    return new JournalLease(Object.freeze({ generation: session.generation, clientId, leaseId }), {
      info, signal: session.abort.signal, current,
      exchange: (command, types, signal, prepared) => {
        if (!current()) return Promise.reject(new Error('Obsolete journal lease'));
        return this.exchange(session, command, types, signal, prepared);
      },
      listen: receive => { session.listeners.add(receive); return () => session.listeners.delete(receive); },
      close: () => this.close(session),
      release: () => { if (session.lease === leaseId) session.lease = undefined; },
    }, signal ? [clientSignal, signal] : [clientSignal]);
  }

  /** Transport cleanup (background, disposal, journal errors); preserves user intent. */
  disconnect(): Promise<void> {
    return this.session ? this.close(this.session) : Promise.resolve();
  }

  disconnectByUser(): Promise<void> {
    return this.changeBinding(() => this.bindings.disableConnection());
  }

  forgetDevice(): Promise<void> {
    return this.changeBinding(() => this.bindings.forget());
  }

  private async changeBinding(change: () => Promise<void>): Promise<void> {
    this.bindingChanges++;
    // Abort immediately, so a late handshake cannot enqueue a new remembered identity.
    const closing = this.disconnect();
    try {
      const results = await Promise.allSettled([change(), closing]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      this.error.set(null);
      if (!this.session) this.state.set('idle');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { this.bindingChanges--; }
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
    const result = session.statusTail.then(() => this.exchange(session, {type: 1}, [0x80], session.abort.signal) as Promise<Status>);
    session.statusTail = result.then(() => {}, error => { void this.close(session, error).catch(() => {}); });
    return result.finally(() => { session.queued--; });
  }

  /** Control serialization ends with the last write. Response promises live in requests. */
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
    const write = session.controlTail.then(async () => {
      this.assertCurrent(session); signal.throwIfAborted(); prepared?.(id);
      for (const frame of fragmentMessage(command,id,'control')) {
        signal.throwIfAborted();
        await this.operation(session, () => {
          // A queued fragment must recheck the lease immediately before touching GATT.
          signal.throwIfAborted();
          return this.adapter.write(session.id,new DataView(frame.buffer,frame.byteOffset,frame.byteLength));
        });
      }
      if (session.requests.has(id)) request.timer = setTimeout(() => request.reject(new Error('STATUS/command timed out')),5000);
    });
    session.controlTail = write.then(() => {}, () => {});
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
    session.abort.abort(reason ?? new BleSessionClosedError('BLE session closed'));
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
