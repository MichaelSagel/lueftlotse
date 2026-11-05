import { Co2Storage } from './co2-storage';
import { Co2Sync } from './co2-sync';
import {
  DestroyRef,
  Injectable,
  inject,
  signal
} from '@angular/core';
import { BleConnection } from './ble-connection';
import { BleSessionClient } from './ble-session';

/** Reuses the protocol session; browser preview never offers journal download. */
@Injectable()
export class BrowserBleSession extends BleConnection {
  private readonly storage = inject(Co2Storage);
  private readonly sync = inject(Co2Sync);
  readonly persistenceError = signal<string | null>(null);
  private settled: Promise<void> = Promise.resolve();
  private disposed = false;
  whenSettled(): Promise<void> { return this.settled; }
  private receipt?: { monotonic: number; wall: number };
  constructor() {
    super();
    const retry = setInterval(
      () => { void this.sync.synchronize(true); },
      30_000);
    inject(DestroyRef).onDestroy(() => { this.disposed = true; clearInterval(retry); });
    const subscription = this.previewEvents.subscribe(event => {
      if (event.kind === 'sample') {
        const deviceId = this.info()?.deviceId;
        const receivedAt = Date.now();
        if (deviceId) {
          const saved = this.storage.saveLiveSample(deviceId, event.sample, receivedAt).then(() => {
            this.persistenceError.set(null);
            return this.disposed ? undefined : this.sync.synchronize(true);
          }).catch(() => this.persistenceError.set('Sensorwert konnte nicht lokal gespeichert werden.'));
          this.settled = Promise.all([this.settled, saved]).then(() => { });
        }
      }
      if (event.kind === 'sample' || event.kind === 'ready') {
        this.receipt = { monotonic: performance.now(), wall: Date.now() };
      } else if (event.reason !== 'stale') this.receipt = undefined;
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
  protected override visibilityChanged(hidden: boolean): void {
    // Timers may be throttled in a background tab. Check the original receipt on return.
    // Wall elapsed also covers platforms whose performance clock pauses during sleep.
    if (!hidden && this.state() === 'ready' && this.receipt &&
      Math.max(performance.now() - this.receipt.monotonic, Date.now() - this.receipt.wall) >= 15000) {
      this.previewExpired();
    }
  }
  override attachClient(): BleSessionClient {
    const client = super.attachClient();
    return { ...client, journal: () => { throw new Error('Journaldownload ist im Browser nicht verfügbar.'); } };
  }
}
