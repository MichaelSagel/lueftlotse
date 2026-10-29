import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { decodeInfo, encodeInfo, Info, supportsLiveSample } from '../ble-protocol/codec';
import { BleBinding } from './ble-binding-model';
import { BLE_SERVICE_SESSION_BRIDGE, NativeServiceState, nativeMessage, nativeUint64 } from './ble-service-session-bridge';
import { BlePhase, BleSession, BleSessionClient, BleSessionClosedError, BleState, BleStatus, PreviewEvent } from './ble-session';
import { NativeJournalLease } from './native-journal-lease';
import { NativeBleBinding } from './native-ble-binding';
import { BleScanner } from './ble-scanner';
import { ANDROID_BLE } from './ble-platform';

/** Android UI facade. Only BleService owns GATT; WebView lifetime owns only journal capabilities. */
@Injectable()
export class NativeBleSession implements BleSession {
  private readonly bridge = inject(BLE_SERVICE_SESSION_BRIDGE);
  private readonly bindings = inject(NativeBleBinding);
  private readonly scanner = inject(BleScanner);
  private readonly android = inject(ANDROID_BLE);
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
  private refreshPending = false;
  private destroyed = false;
  private command = 0;
  private readerEpoch = 0;
  private bindingRead = 0;
  private nativeBindingError: string | null = null;
  private connecting = false;
  private pendingStart?: Promise<NativeServiceState>;
  private migration?: Promise<void>;
  private migrated = false;
  private sampleCounter?: bigint;
  private sampleUptime?: bigint;
  private sampleReceived?: bigint;
  private restoreSample = true;
  private readonly visibility = () => {
    this.readerEpoch++; this.restoreSample = true;
    if (this.document.hidden) { this.lease?.revoke(); this.preview.next({ kind: 'unavailable' }); }
    else { this.refreshPending = true; void this.refresh(); if (this.migrated) void this.readBinding().catch(() => {}); }
  };
  constructor() {
    this.document.addEventListener('visibilitychange', this.visibility);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true; this.command++; clearInterval(this.polling);
      this.lease?.revoke(); this.connectionAbort.abort(new BleSessionClosedError('WebView detached'));
      for (const client of this.clients) client.abort(new Error('BLE client revoked'));
      this.clients.clear(); this.document.removeEventListener('visibilitychange', this.visibility); this.preview.complete();
      // Never stop a service-owned connection because an Activity, page or waiter disappeared.
    });
  }
  attachClient(): BleSessionClient {
    if (!this.android || this.destroyed || this.clients.size >= 8) throw new Error('Native BLE client unavailable');
    const client = new AbortController(); this.clients.add(client);
    const id = crypto.randomUUID();
    const owned = () => { client.signal.throwIfAborted(); if (this.destroyed) throw new Error('Native BLE adapter destroyed'); };
    if (!this.polling) {
      this.readerEpoch++; this.restoreSample = true; void this.readBinding().catch(() => {}); void this.refresh();
      this.polling = setInterval(() => { void this.refresh(); }, 1000);
    }
    return {
      id, signal: client.signal,
      connect: address => { owned(); return this.connect(address, client.signal); },
      disconnect: async () => { owned(); await this.disconnect(false); },
      disconnectByUser: async () => { owned(); await this.disconnect(true); },
      forgetDevice: async () => {
        owned(); this.command++;
        try {
          await this.pendingStart?.catch(() => {}); owned();
          // Native tombstone precedes native close. Never pre-revoke an in-flight journal here.
          const saved = await this.bindings.forget(); owned(); this.binding.set(saved.binding); this.bindingError.set(null);
        } catch (error) { this.bindingError.set('BLE binding storage: ' + String(error)); throw error; }
        finally { this.lease?.revoke(); await this.refresh(); }
      },
      journal: signal => {
        owned(); signal?.throwIfAborted();
        if (this.document.hidden || this.state() !== 'ready' || !this.run || !this.info() || this.lease || !this.migrated) throw new Error('Native journal unavailable/busy');
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
  private ensureMigration(): Promise<void> {
    if (!this.android) return Promise.reject(new Error('Native calls forbidden outside Android'));
    if (!this.migration) {
      this.migration = this.bindings.migrate().then(() => { this.migrated = true; }, error => {
        this.migration = undefined; this.migrated = false;
        throw new Error('BLE migration failed: ' + String(error));
      });
    }
    return this.migration;
  }
  private async readBinding() {
    const read = ++this.bindingRead, epoch = this.readerEpoch;
    const current = () => !this.destroyed && read === this.bindingRead && epoch === this.readerEpoch;
    this.bindingLoading.set(true);
    try {
      await this.ensureMigration(); const saved = await this.bindings.refresh();
      if (current()) { this.binding.set(saved.binding); this.bindingError.set(this.nativeBindingError); } return saved;
    } catch (error) { if (current()) this.bindingError.set(String(error)); throw error; }
    finally { if (read === this.bindingRead) this.bindingLoading.set(false); }
  }
  private async connect(address: string, signal: AbortSignal): Promise<BleStatus> {
    if (!this.android || this.document.hidden || this.connecting || this.state() === 'ready' || this.state() === 'closing') throw new Error('Native connection unavailable');
    this.connecting = true; const command = ++this.command; let releaseScan: (() => void) | undefined;
    const current = () => { signal.throwIfAborted(); if (command !== this.command || this.destroyed) throw new Error('Stale connect'); };
    this.state.set('connecting'); this.phase.set('scan-stop'); this.error.set(null);
    try {
      releaseScan = await this.scanner.holdStopped(); current();
      this.phase.set('migrate'); const saved = await this.readBinding(); current();
      this.phase.set('permissions');
      const permissions = await this.bridge.requestPermissions(); current();
      if (!permissions.permissionsGranted) throw new Error('BLE permissions: Bluetooth und Benachrichtigungen müssen erlaubt sein.');
      if (this.document.hidden) throw new Error('BLE permissions: Verbindung nur aus der sichtbaren App starten.');
      this.phase.set('connect');
      this.pendingStart = this.bridge.start({ bleAddress: address, expectedDeviceId: saved.binding?.deviceId });
      const started = await this.pendingStart; current();
      const run = started.runId; if (!run) throw new Error('Missing native run');
      const deadline = performance.now() + 35000;
      for (;;) {
        current(); const requested = performance.now(); const state = await this.bridge.getState(); current();
        if (state.runId !== run) throw new Error('Connection replaced');
        this.apply(state, requested);
        if (state.state === 'ready' && this.status()) { const status = this.status()!; await this.readBinding(); current(); return status; }
        if (state.state === 'stopped' || state.state === 'error') throw new Error(state.reason ?? 'Native handshake failed');
        if (performance.now() >= deadline) { await this.bridge.closeSession({ runId: run }); throw new Error('Native handshake timeout'); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      if (!this.destroyed && command === this.command) { this.state.set('error'); this.phase.set('error'); this.error.set(String(error)); }
      throw error;
    } finally { this.pendingStart = undefined; this.connecting = false; releaseScan?.(); }
  }
  private async disconnect(byUser: boolean): Promise<void> {
    if (!this.android) throw new Error('Native calls forbidden outside Android');
    this.command++;
    await this.pendingStart?.catch(() => {});
    const value = await this.bridge.getState(); // Also works after Activity/process recreation or radio loss.
    this.state.set('closing'); this.phase.set('closing');
    try {
      if (byUser) {
        // A storage read failure must not prevent the native save-or-close action for a live run.
        const input = value.runId ? { runId: value.runId } : { revision: (await this.readBinding()).revision };
        const result = await this.bridge.disconnect(input);
        this.apply(result, performance.now());
      } else if (value.runId) this.apply(await this.bridge.closeSession({ runId: value.runId }), performance.now());
      else this.apply(value, performance.now());
    } catch (error) { this.error.set(String(error)); throw error; }
    finally {
      this.lease?.revoke(); this.preview.next({ kind: 'unavailable' });
      if (byUser) await this.readBinding();
    }
  }
  private async refresh(): Promise<void> {
    if (this.reading || this.destroyed || this.document.hidden || this.connecting || !this.clients.size) return;
    this.reading = true; this.refreshPending = false;
    const command = this.command, epoch = this.readerEpoch, requested = performance.now();
    try {
      const state = await this.bridge.getState();
      if (!this.destroyed && command === this.command && epoch === this.readerEpoch && this.clients.size && !this.document.hidden) {
        const changed = this.run !== (state.runId ?? undefined) || this.state() !== this.uiState(state);
        this.apply(state, requested);
        if (changed && this.migrated) await this.readBinding(); // Includes notification Trennen.
      }
    } catch (error) {
      if (!this.destroyed && command === this.command && epoch === this.readerEpoch) {
        this.error.set(String(error)); this.lease?.revoke(); this.preview.next({ kind: 'unavailable', reason: 'error' });
      }
    } finally { this.reading = false; if (this.refreshPending) void this.refresh(); }
  }
  private uiState(value: NativeServiceState): BleState {
    return value.state === 'ready' ? 'ready' : value.state === 'starting' || value.state === 'connecting' ? 'connecting' :
      value.state === 'stopping' ? 'closing' : value.state === 'error' ? 'error' : 'idle';
  }
  private apply(value: NativeServiceState, requested: number): void {
    if ((value.runId ?? undefined) !== this.run) {
      this.connectionAbort.abort(new BleSessionClosedError('Connection generation changed')); this.connectionAbort = new AbortController();
      this.run = value.runId ?? undefined; this.sampleCounter = undefined; this.sampleUptime = undefined; this.sampleReceived = undefined; this.restoreSample = true;
    }
    const state = this.uiState(value), wasReady = this.state() === 'ready';
    this.state.set(state); this.phase.set(state === 'connecting' ? 'status' : state);
    this.nativeBindingError = value.bindingError;
    if (value.bindingError) this.bindingError.set(value.bindingError);
    if (state !== 'ready') { this.info.set(null); this.status.set(null); this.lease?.revoke(); this.preview.next({ kind: 'unavailable' }); return; }
    const input = value.info as Info;
    if (!input || input.major !== 1) throw new Error('Invalid native Info');
    const info = decodeInfo(encodeInfo(input.deviceId, input.capabilities, input.minor));
    const status = nativeMessage(value.status); if (status.type !== 0x80) throw new Error('Missing handshake STATUS');
    this.info.set(info); this.status.set(status); this.error.set(null);
    if (!wasReady || this.restoreSample) this.preview.next({ kind: 'ready' });
    if (value.lastSample) {
      const sample = nativeMessage(value.lastSample);
      const received = nativeUint64((value.lastSample as { receivedAtElapsedMs: string }).receivedAtElapsedMs), now = nativeUint64(value.nowElapsedMs);
      // Native elapsed time includes sleep. Bridge transit is conservatively included, never subtracted.
      const elapsed = now >= received ? now - received : 15000n;
      const ageMs = elapsed >= 15000n ? 15000 : Number(elapsed) + Math.max(0, performance.now() - requested);
      if (sample.type !== 0x8a || !supportsLiveSample(info) || sample.bootId !== status.bootId) throw new Error('Invalid native preview');
      if (ageMs >= 15000) this.preview.next({ kind: 'unavailable', reason: 'stale' });
      else if (!value.sampleAvailable) this.preview.next({ kind: 'unavailable', reason: 'error' });
      else {
        const fresh = this.sampleCounter === undefined || (sample.sampleCounter > this.sampleCounter && sample.uptimeMs >= this.sampleUptime!);
        const same = sample.sampleCounter === this.sampleCounter && sample.uptimeMs === this.sampleUptime && received === this.sampleReceived;
        if (fresh || (this.restoreSample && same)) this.preview.next({ kind: 'sample', sample, ageMs });
        if (fresh) { this.sampleCounter = sample.sampleCounter; this.sampleUptime = sample.uptimeMs; this.sampleReceived = received; }
      }
    } else if (value.reason) this.preview.next({ kind: 'unavailable', reason: 'error' });
    this.restoreSample = false;
  }
}
