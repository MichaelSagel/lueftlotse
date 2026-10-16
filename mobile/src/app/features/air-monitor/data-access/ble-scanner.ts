import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BleClient, ScanResult } from '@capacitor-community/bluetooth-le';

type ScanState = 'idle' | 'scanning' | 'done' | 'off' | 'denied' | 'error';
export interface DiscoveredDevice { id: string; name: string; rssi: number | undefined; }

@Injectable()
export class BleScanner {
  readonly available = Capacitor.getPlatform() === 'android';
  readonly state = signal<ScanState>('idle');
  readonly devices = signal<DiscoveredDevice[]>([]);
  private readonly starting = signal(false);
  private readonly stopping = signal(false);
  readonly busy = computed(() => this.starting() || this.stopping());
  readonly message = computed(() => {
    switch (this.state()) {
      case 'scanning': return 'Suche läuft … (maximal 10 Sekunden)';
      case 'done': return this.devices().length ? 'Suche beendet.' : 'Keine Geräte gefunden.';
      case 'off': return 'Bluetooth ist ausgeschaltet. Bitte Bluetooth einschalten und erneut suchen.';
      case 'denied': return 'Berechtigung abgelehnt. Bitte „Geräte in der Nähe“ in den App-Einstellungen erlauben.';
      case 'error': return 'Die Bluetooth-Suche konnte nicht ausgeführt oder beendet werden. Bitte erneut versuchen.';
      default: return 'Die Suche startet erst nach einem Klick. Es wird noch keine Verbindung hergestellt.';
    }
  });
  private readonly document = inject(DOCUMENT);
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private nativeStarted = false;
  private cleanup?: Promise<void>;
  private launch?: Promise<void>;
  private stopOperation?: Promise<void>;
  private destroyed = false;
  private readonly onVisibility = () => { if (this.document.hidden) void this.stop().catch(() => {}); };

  constructor() {
    this.document.addEventListener('visibilitychange', this.onVisibility);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.document.removeEventListener('visibilitychange', this.onVisibility);
      void this.stop().catch(() => {});
    });
  }

  start(): Promise<void> {
    if (this.destroyed || !this.available || this.busy() || this.state() === 'scanning' || this.document.hidden) return Promise.resolve();
    this.starting.set(true);
    this.launch = this.startScan().finally(() => { this.launch = undefined; this.starting.set(false); });
    return this.launch;
  }

  private async startScan(): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation && !this.document.hidden;
    this.devices.set([]);
    this.state.set('scanning');
    try {
      // A failed stop must be retried before starting another native scan.
      await this.stopNative();
      if (!current() || this.nativeStarted) return;
      await BleClient.initialize({ androidNeverForLocation: true });
      if (!current()) return;
      if (!await BleClient.isEnabled()) {
        if (current()) this.state.set('off');
        return;
      }
      if (!current()) return;
      await BleClient.requestLEScan({ allowDuplicates: true }, result => {
        if (current()) this.receive(result);
      });
      this.nativeStarted = true;
      if (!current()) return;
      this.timer = setTimeout(() => void this.stop().catch(() => {}), 10_000);
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
        this.state.set(/permission|denied/i.test(message) ? 'denied' : 'error');
      }
      await this.stopNative().catch(() => {});
    }
  }

  /** Resolves only after an in-flight launch and its native cleanup have settled. */
  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    ++this.generation;
    clearTimeout(this.timer);
    if (this.state() === 'scanning') this.state.set('done');
    this.stopping.set(true);
    const launch = this.launch;
    this.stopOperation = (async () => {
      if (launch) await launch;
      await this.stopNative();
    })().finally(() => { this.stopOperation = undefined; this.stopping.set(false); });
    return this.stopOperation;
  }

  private stopNative(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    if (!this.nativeStarted) return Promise.resolve();
    this.cleanup = BleClient.stopLEScan()
      .then(() => { this.nativeStarted = false; })
      .catch(error => { this.state.set('error'); throw error; })
      .finally(() => { this.cleanup = undefined; });
    return this.cleanup;
  }

  private receive(result: ScanResult): void {
    const id = result.device.deviceId;
    this.devices.update(devices => {
      const previous = devices.find(device => device.id === id);
      const device = { id, name: result.localName?.trim() || result.device.name?.trim() || previous?.name || 'Unbekanntes Gerät', rssi: result.rssi };
      return previous ? devices.map(item => item.id === id ? device : item) : [...devices, device];
    });
  }
}
