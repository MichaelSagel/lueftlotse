import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { supportsLiveSample } from '../ble-protocol/codec';
import { BleConnection, LiveSample } from './ble-connection';

export type SensorState = 'disconnected' | 'connecting' | 'unsupported' | 'waiting' | 'live' | 'stale';

/** Volatile Sensor display only; never feeds the CO2_SOURCE history path. */
@Injectable()
export class Co2Monitor {
  private readonly connection = inject(BleConnection);
  private readonly sample = signal<LiveSample | null>(null);
  private readonly expired = signal(false);
  private timer?: ReturnType<typeof setTimeout>;
  readonly sensorState = computed<SensorState>(() => {
    if (this.connection.state() === 'connecting') return 'connecting';
    if (this.connection.state() !== 'ready') return 'disconnected';
    const info = this.connection.info();
    if (!info || !supportsLiveSample(info)) return 'unsupported';
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
  })[this.sensorState()]);

  constructor() {
    const subscription = this.connection.previewEvents.subscribe(event => {
      if (event.kind === 'unavailable') this.clear();
      else if (event.kind === 'ready') {
        this.clear();
        this.waitForSample();
      } else {
        this.sample.set(event.sample); this.expired.set(false); this.armTimeout();
      }
    });
    this.waitForSample();
    inject(DestroyRef).onDestroy(() => { subscription.unsubscribe(); this.clear(); });
  }

  private waitForSample(): void {
    const info = this.connection.info();
    if (this.connection.state() === 'ready' && info && supportsLiveSample(info)) this.armTimeout();
  }
  private armTimeout(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined; this.sample.set(null); this.expired.set(true);
    }, 15000);
  }
  private clear(): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.sample.set(null); this.expired.set(false);
  }
}
