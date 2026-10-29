import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { supportsLiveSample } from '../ble-protocol/codec';
import { BLE_SESSION, LiveSample } from './ble-session';

export type SensorState = 'disconnected' | 'connecting' | 'unsupported' | 'waiting' | 'live' | 'stale' | 'unavailable';

/** Volatile Sensor display only; never feeds the CO2_SOURCE history path. */
@Injectable()
export class Co2Monitor {
  private readonly connection = inject(BLE_SESSION);
  private readonly sample = signal<LiveSample | null>(null);
  private readonly expired = signal(false);
  private readonly unavailable = signal(false);
  private timer?: ReturnType<typeof setTimeout>;
  readonly sensorState = computed<SensorState>(() => {
    if (this.connection.state() === 'connecting') return 'connecting';
    if (this.connection.state() !== 'ready') return 'disconnected';
    const info = this.connection.info();
    if (!info || !supportsLiveSample(info)) return 'unsupported';
    if (this.unavailable()) return 'unavailable';
    if (this.expired()) return 'stale';
    return this.sample() ? 'live' : 'waiting';
  });
  // Sensor uptime is never converted to a fictional wall-clock measurement time.
  readonly current = computed(() => this.sensorState() === 'live' ? this.sample() : null);
  readonly sensorText = computed(() => ({
    disconnected: 'Sensor nicht verfügbar · Kein Gerät verbunden.',
    connecting: 'Sensor nicht verfügbar · Verbindung wird hergestellt …',
    unsupported: 'Sensor nicht verfügbar · Dieses Gerät bietet keine aktuelle Sensorvorschau.',
    waiting: 'Warte auf einen neuen Sensorwert …',
    live: 'Sensor verbunden · Aktuelle Vorschau.',
    stale: 'Sensor nicht verfügbar · Seit 15 Sekunden kein neuer Messwert.',
    unavailable: 'Sensor nicht verfügbar · Keine gültigen aktuellen Daten.',
  })[this.sensorState()]);

  constructor() {
    const subscription = this.connection.previewEvents.subscribe(event => {
      if (event.kind === 'unavailable') {
        this.clear(); this.expired.set(event.reason === 'stale'); this.unavailable.set(event.reason === 'error');
      }
      else if (event.kind === 'ready') {
        this.clear();
        this.waitForSample();
      } else {
        this.sample.set(event.sample); this.expired.set(false); this.unavailable.set(false); this.armTimeout(event.ageMs ?? 0);
      }
    });
    this.waitForSample();
    const client = this.connection.attachClient();
    inject(DestroyRef).onDestroy(() => { subscription.unsubscribe(); client.revoke(); this.clear(); });
  }

  private waitForSample(): void {
    const info = this.connection.info();
    if (this.connection.state() === 'ready' && info && supportsLiveSample(info)) this.armTimeout();
  }
  private armTimeout(ageMs = 0): void {
    clearTimeout(this.timer);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= 15000) {
      this.timer = undefined; this.sample.set(null); this.expired.set(true); return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined; this.sample.set(null); this.expired.set(true);
    }, 15000 - ageMs);
  }
  private clear(): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.sample.set(null); this.expired.set(false); this.unavailable.set(false);
  }
}
