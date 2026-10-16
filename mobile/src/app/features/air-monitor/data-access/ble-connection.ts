import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { decodeInfo, Message } from '../ble-protocol/codec';
import { FragmentAssembler, fragmentMessage } from '../ble-protocol/fragments';
import { BLE_ADAPTER } from './ble-adapter';
import { BleScanner } from './ble-scanner';

type Status = Extract<Message, { type: 0x80 }>;
type Info = ReturnType<typeof decodeInfo>;
interface Request {
  id: number;
  resolve: (status: Status) => void;
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
  request?: Request;
  cleanup?: Promise<void>;
  closing?: Promise<void>;
}

/** Handshake/STATUS only. No Co2Source, measurement imports, ACKs or automatic reconnect. */
@Injectable()
export class BleConnection {
  private readonly adapter = inject(BLE_ADAPTER);
  private readonly scanner = inject(BleScanner);
  private readonly document = inject(DOCUMENT);
  readonly state = signal<'idle' | 'connecting' | 'ready' | 'closing' | 'error'>('idle');
  readonly info = signal<Info | null>(null);
  readonly status = signal<Status | null>(null);
  readonly error = signal<string | null>(null);
  private session?: Session;
  private destroyed = false;
  private readonly background = () => { if (this.document.hidden) void this.disconnect().catch(() => {}); };

  constructor() {
    this.document.addEventListener('visibilitychange', this.background);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.document.removeEventListener('visibilitychange', this.background);
      void this.disconnect().catch(() => {});
    });
  }

  async connect(id: string, signal?: AbortSignal): Promise<Status> {
    if (!this.adapter.available()) throw new Error('BLE is available only in the Android app');
    if (this.destroyed || this.document.hidden || this.session || !id) throw new Error('BLE session unavailable');
    signal?.throwIfAborted();
    const session: Session = { id, abort: new AbortController(), assembler: new FragmentAssembler('events'),
      pending: new Set(), connecting: false, subscribed: false, nextId: 0, queued: 0, tail: Promise.resolve() };
    this.session = session; this.info.set(null); this.status.set(null); this.error.set(null); this.state.set('connecting');
    const cancel = () => { void this.close(session, signal?.reason ?? new Error('Cancelled')).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.operation(session, () => this.scanner.stop(), 15000);
      await this.operation(session, () => this.adapter.initialize(), 10000);
      session.connecting = true;
      await this.operation(session, () => this.adapter.connect(id, () => {
        if (this.current(session)) void this.close(session, new Error('BLE disconnected')).catch(() => {});
      }), 10000);
      const value = await this.operation(session, () => this.adapter.readInfo(id));
      if (value.byteLength !== 20) throw new Error('Info must be 20 bytes');
      const info = decodeInfo(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      this.info.set(info);
      session.subscribed = true; // Also clean up a subscription whose Promise completes late or fails.
      await this.operation(session, () => this.adapter.subscribe(id, value => this.receive(session, value)));
      const status = await this.enqueueStatus(session);
      this.assertCurrent(session); this.state.set('ready'); return status;
    } catch (error) {
      void this.close(session, error).catch(() => {});
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  getStatus(): Promise<Status> {
    const session = this.session;
    if (!session || this.state() !== 'ready') return Promise.reject(new Error('BLE is not ready'));
    return this.enqueueStatus(session);
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
    const result = session.tail.then(async () => {
      this.assertCurrent(session);
      if (session.nextId > 65534) throw new Error('BLE message IDs exhausted; reconnect required');
      const id = session.nextId++;
      const response = new Promise<Status>((resolve, reject) => { session.request = { id, resolve, reject }; });
      // Attach immediately: disconnect or an ERROR can arrive while write is still pending.
      void response.catch(() => {});
      try {
        for (const frame of fragmentMessage({ type: 1 }, id, 'control')) {
          await this.operation(session, () => this.adapter.write(session.id, new DataView(frame.buffer, frame.byteOffset, frame.byteLength)));
        }
        if (session.request) session.request.timer = setTimeout(() => session.request?.reject(new Error('STATUS timed out')), 5000);
        return await response;
      } finally {
        clearTimeout(session.request?.timer); session.request = undefined;
      }
    });
    session.tail = result.then(() => {}, error => { void this.close(session, error).catch(() => {}); });
    return result.finally(() => { session.queued--; });
  }

  private receive(session: Session, value: DataView): void {
    if (!this.current(session)) return;
    try {
      if (value.byteLength < 7 || value.byteLength > 20) throw new Error('Invalid Events ATT length');
      const decoded = session.assembler.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
      if (!decoded) return;
      const message = decoded.message;
      if (message.type === 0x80) {
        if (message.requestId === 65535 || message.requestId === session.request?.id) this.status.set(message);
        if (message.requestId === session.request?.id) {
          clearTimeout(session.request.timer); session.request.resolve(message); session.request = undefined;
        }
      } else if (message.type === 0xff && (message.requestId === 65535 || message.requestId === session.request?.id)) {
        throw new Error(`BLE protocol error ${message.code}`);
      }
      // Other valid messages have no storage/current-reading side effects at this stage.
    } catch (error) { void this.close(session, error).catch(() => {}); }
  }

  private close(session: Session, reason?: unknown): Promise<void> {
    if (session.closing) return session.closing;
    session.abort.abort(reason ?? new Error('BLE session closed'));
    session.assembler.dispose(); clearTimeout(session.request?.timer);
    session.request?.reject(session.abort.signal.reason); session.request = undefined;
    if (reason) { this.error.set(reason instanceof Error ? reason.message : String(reason)); this.state.set('error'); }
    else this.state.set('closing');
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
        this.error.set('BLE cleanup failed; session cannot be reused'); this.state.set('error');
        throw new Error('BLE cleanup failed');
      }
      if (this.session === session) { this.session = undefined; this.info.set(null); this.status.set(null); if (!reason) this.state.set('idle'); }
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
