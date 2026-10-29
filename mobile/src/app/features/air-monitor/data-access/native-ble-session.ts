import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { decodeInfo, encodeInfo, Info, supportsLiveSample } from '../ble-protocol/codec';
import { BleBinding } from './ble-binding-model';
import { validatedNativeBinding } from './ble-service-binding-bridge';
import { BLE_SERVICE_SESSION_BRIDGE, NativeServiceState, nativeMessage, nativeUint64 } from './ble-service-session-bridge';
import { BlePhase, BleSession, BleSessionClient, BleSessionClosedError, BleState, BleStatus, PreviewEvent } from './ble-session';
import { NativeJournalLease } from './native-journal-lease';

/** Opt-in BLE_SESSION adapter. The working route still aliases BleConnection. Never migrates or owns GATT. */
@Injectable()
export class NativeBleSession implements BleSession {
  private readonly bridge = inject(BLE_SERVICE_SESSION_BRIDGE);
  private readonly document = inject(DOCUMENT);
  readonly state = signal<BleState>('idle');
  readonly phase = signal<BlePhase>('idle');
  readonly info = signal<Info | null>(null);
  readonly status = signal<BleStatus | null>(null);
  readonly error = signal<string | null>(null);
  readonly binding = signal<BleBinding | null>(null);
  readonly bindingError = signal<string | null>(null);
  readonly bindingLoading = signal(false);
  private readonly preview = new Subject<PreviewEvent>();
  readonly previewEvents = this.preview.asObservable();
  private readonly clients = new Set<AbortController>();
  private lease?: NativeJournalLease;
  private run?: string;
  private connectionAbort = new AbortController();
  private polling?: ReturnType<typeof setInterval>;
  private reading = false;
  private destroyed = false;
  private command = 0;
  private readerEpoch = 0;
  private bindingRead = 0;
  private connecting = false;
  private sampleCounter?: bigint;
  private sampleUptime?: bigint;
  private seenSnapshot = false;
  private readonly visibility = () => {
    this.readerEpoch++;
    if (this.document.hidden) { this.lease?.revoke(); this.preview.next({ kind: 'unavailable' }); }
    else { this.seenSnapshot = false; void this.refresh(); }
  };
  constructor() {
    this.document.addEventListener('visibilitychange', this.visibility);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true; this.command++; clearInterval(this.polling);
      this.lease?.revoke(); this.connectionAbort.abort(new BleSessionClosedError('Native adapter destroyed'));
      for (const client of this.clients) client.abort(new Error('BLE client revoked'));
      this.clients.clear(); this.document.removeEventListener('visibilitychange', this.visibility); this.preview.complete();
    });
  }
  attachClient(): BleSessionClient {
    if (this.destroyed || this.clients.size >= 8) throw new Error('Native BLE client unavailable');
    const client = new AbortController(); this.clients.add(client);
    const id = crypto.randomUUID();
    const owned = () => { client.signal.throwIfAborted(); if (this.destroyed) throw new Error('Native BLE adapter destroyed'); };
    if (!this.polling) {
      this.readerEpoch++; this.seenSnapshot = false; void this.readBinding().catch(() => {}); void this.refresh();
      this.polling = setInterval(() => { void this.refresh(); }, 1000);
    }
    return {
      id, signal: client.signal,
      connect: address => { owned(); return this.connect(address, client.signal); },
      disconnect: async () => { owned(); await this.disconnect(false); },
      disconnectByUser: async () => { owned(); await this.disconnect(true); },
      forgetDevice: async () => {
        owned(); const saved = await this.readBinding(); owned();
        if (!saved.migrationComplete) throw new Error('Explicit native migration required');
        this.lease?.revoke();
        const result = validatedNativeBinding(await this.bridge.forgetBinding({ revision: saved.revision }));
        owned(); this.binding.set(result.binding); await this.refresh();
      },
      journal: signal => {
        owned(); signal?.throwIfAborted();
        if (this.document.hidden || this.state() !== 'ready' || !this.run || !this.info() || this.lease) throw new Error('Native journal unavailable/busy');
        const lease = new NativeJournalLease({ generation: this.run, clientId: id, leaseId: crypto.randomUUID() }, this.info()!, this.bridge,
          [client.signal, this.connectionAbort.signal, ...(signal ? [signal] : [])], () => { if (this.lease === lease) this.lease = undefined; });
        this.lease = lease; return lease;
      },
      revoke: () => {
        client.abort(new DOMException('BLE client revoked', 'AbortError')); this.clients.delete(client);
        if (!this.clients.size) { this.readerEpoch++; clearInterval(this.polling); this.polling = undefined; }
      },
    };
  }
  private async readBinding() {
    const read = ++this.bindingRead, command = this.command, epoch = this.readerEpoch;
    const current = () => !this.destroyed && read === this.bindingRead && command === this.command && epoch === this.readerEpoch;
    this.bindingLoading.set(true);
    try { const saved = validatedNativeBinding(await this.bridge.getBinding()); if (current()) { this.binding.set(saved.binding); this.bindingError.set(null); } return saved; }
    catch (error) { if (current()) this.bindingError.set(String(error)); throw error; }
    finally { if (read === this.bindingRead) this.bindingLoading.set(false); }
  }
  private async connect(address: string, signal: AbortSignal): Promise<BleStatus> {
    if (this.connecting || this.state() === 'ready' || this.state() === 'closing') throw new Error('Native connection unavailable');
    this.connecting = true; const command = ++this.command; let run: string | null = null;
    const stop = () => { if (run) void this.bridge.closeSession({ runId: run }).catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    this.state.set('connecting'); this.phase.set('connect');
    try {
      const saved = await this.readBinding(); signal.throwIfAborted();
      if (command !== this.command || this.destroyed) throw new Error('Stale connect');
      if (!saved.migrationComplete) throw new Error('Explicit native migration required');
      const started = await this.bridge.start({ bleAddress: address, expectedDeviceId: saved.binding?.deviceId }); run = started.runId;
      signal.throwIfAborted();
      if (command !== this.command || this.destroyed) throw new Error('Stale connect');
      if (!run) throw new Error('Missing native run');
      const deadline = performance.now() + 35000;
      for (;;) {
        signal.throwIfAborted(); if (command !== this.command || this.destroyed) throw new Error('Stale connect');
        const state = await this.bridge.getState(); signal.throwIfAborted();
        if (command !== this.command || this.destroyed) throw new Error('Stale connect');
        if (state.runId !== run) throw new Error('Connection replaced');
        this.apply(state);
        if (state.state === 'ready' && this.status()) {
          const status = this.status()!; await this.readBinding(); signal.throwIfAborted();
          if (command !== this.command || this.destroyed) throw new Error('Stale connect');
          return status;
        }
        if (state.state === 'stopped' || state.state === 'error' || performance.now() >= deadline) throw new Error(state.reason ?? 'Native handshake timeout');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      stop(); if (!this.destroyed && command === this.command) { this.state.set('error'); this.phase.set('error'); this.error.set(String(error)); }
      throw error;
    } finally { signal.removeEventListener('abort', stop); this.connecting = false; }
  }
  private async disconnect(byUser: boolean): Promise<void> {
    this.command++; this.lease?.revoke();
    const run = this.run;
    if (!run) return;
    this.state.set('closing'); this.phase.set('closing');
    this.connectionAbort.abort(new BleSessionClosedError('Disconnected')); this.preview.next({ kind: 'unavailable' });
    try { this.apply(await (byUser ? this.bridge.disconnect({ runId: run }) : this.bridge.closeSession({ runId: run }))); }
    finally { if (byUser) await this.readBinding(); }
  }
  private async refresh(): Promise<void> {
    if (this.reading || this.destroyed || this.document.hidden || this.connecting || !this.clients.size) return;
    this.reading = true; const command = this.command, epoch = this.readerEpoch;
    try { const state = await this.bridge.getState(); if (!this.destroyed && command === this.command && epoch === this.readerEpoch && this.clients.size && !this.document.hidden) this.apply(state); }
    catch (error) {
      if (!this.destroyed && command === this.command && epoch === this.readerEpoch) { this.error.set(String(error)); this.lease?.revoke(); this.preview.next({ kind: 'unavailable' }); }
    } finally { this.reading = false; }
  }
  private apply(value: NativeServiceState): void {
    if (value.runId !== this.run) {
      this.connectionAbort.abort(new BleSessionClosedError('Connection generation changed')); this.connectionAbort = new AbortController();
      this.run = value.runId ?? undefined; this.sampleCounter = undefined; this.sampleUptime = undefined; this.seenSnapshot = false;
    }
    const state: BleState = value.state === 'ready' ? 'ready' : value.state === 'starting' || value.state === 'connecting' ? 'connecting' :
      value.state === 'stopping' ? 'closing' : value.state === 'error' ? 'error' : 'idle';
    const wasReady = this.state() === 'ready';
    this.state.set(state); this.phase.set(state === 'connecting' ? 'status' : state); this.bindingError.set(value.bindingError);
    if (state !== 'ready') {
      this.info.set(null); this.status.set(null); this.lease?.revoke(); this.preview.next({ kind: 'unavailable' }); return;
    }
    const input = value.info as Info;
    if (!input || input.major !== 1) throw new Error('Invalid native Info');
    const info = decodeInfo(encodeInfo(input.deviceId, input.capabilities, input.minor));
    const status = nativeMessage(value.status); if (status.type !== 0x80) throw new Error('Missing handshake STATUS');
    this.info.set(info); this.status.set(status); this.error.set(null);
    if (!wasReady) this.preview.next({ kind: 'ready' });
    if (!value.sampleAvailable || !value.lastSample) this.preview.next({ kind: 'unavailable' });
    else {
      const sample = nativeMessage(value.lastSample);
      const received = nativeUint64((value.lastSample as {receivedAtElapsedMs: string}).receivedAtElapsedMs);
      const now = nativeUint64(value.nowElapsedMs);
      if (sample.type !== 0x8a || !supportsLiveSample(info) || sample.bootId !== status.bootId || now < received || now - received >= 15000n) this.preview.next({ kind: 'unavailable' });
      else if (this.sampleCounter === undefined || (sample.sampleCounter > this.sampleCounter && sample.uptimeMs >= this.sampleUptime!)) {
        if (this.seenSnapshot) this.preview.next({ kind: 'sample', sample }); // Never replay a cached sample on attachment/resume.
        this.sampleCounter = sample.sampleCounter; this.sampleUptime = sample.uptimeMs;
      }
    }
    this.seenSnapshot = true;
  }
}
