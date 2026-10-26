import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { supportsLiveSample } from '../ble-protocol/codec';
import { BleConnection, LiveSample } from './ble-connection';
import { CO2_SOURCE } from './co2-source';

export type DisplaySource = 'simulator' | 'sensor';
export type SensorState = 'disconnected' | 'connecting' | 'unsupported' | 'waiting' | 'live' | 'stale';

/** Current display only. CO2_SOURCE/readings remains the simulator's persistence path. */
@Injectable()
export class Co2Monitor {
  private readonly simulator = inject(CO2_SOURCE);
  private readonly connection = inject(BleConnection);
  private readonly selection = signal<DisplaySource>('simulator');
  readonly selected = this.selection.asReadonly();
  readonly simulatorState = this.simulator.state;
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
  readonly current = computed(() => this.selected() === 'simulator'
    ? this.simulator.current() : this.sensorState() === 'live' ? this.sample() : null);
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
        if (this.selected() === 'sensor') this.waitForSample();
      } else if (this.selected() === 'sensor') {
        this.sample.set(event.sample); this.expired.set(false); this.armTimeout();
      }
    });
    inject(DestroyRef).onDestroy(() => { subscription.unsubscribe(); this.clear(); this.simulator.stop(); });
  }

  select(source: DisplaySource): void {
    if (source === this.selected()) return;
    this.clear(); this.selection.set(source);
    if (source === 'sensor') { this.simulator.stop(); this.waitForSample(); }
    else this.simulator.start();
  }

  toggleSimulation(): void {
    if (this.selected() !== 'simulator') return;
    if (this.simulator.state().status === 'running') this.simulator.stop();
    else this.simulator.start();
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
