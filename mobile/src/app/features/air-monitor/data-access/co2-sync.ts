import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Co2Storage, PendingMeasurement, SyncSnapshot } from './co2-storage';
import { MEASUREMENT_API_CONFIG } from './measurement-api.config';

class ServerError extends Error { constructor(readonly status: number) { super('Batch rejected'); } }

@Injectable()
export class Co2Sync {
  private readonly storage = inject(Co2Storage);
  private readonly config = inject(MEASUREMENT_API_CONFIG);
  readonly endpoint = this.apiEndpoint();
  readonly running = signal(false);
  readonly counts = signal({ pending: 0, synced: 0 });
  readonly total = signal(0);
  readonly completed = signal(0);
  readonly result = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  private countsRequest = 0;
  private controller: AbortController | undefined;

  constructor() { inject(DestroyRef).onDestroy(() => this.controller?.abort()); }

  async refreshCounts(): Promise<void> {
    try { await this.readCounts(); }
    catch { this.error.set('Der lokale Synchronisierungsstand konnte nicht geladen werden.'); }
  }
  private async readCounts(): Promise<SyncSnapshot> {
    const revision = ++this.countsRequest;
    const snapshot = await this.storage.syncSnapshot();
    if (revision === this.countsRequest) this.counts.set({ pending: snapshot.pending, synced: snapshot.synced });
    return snapshot;
  }

  async synchronize(): Promise<void> {
    if (this.running()) return;
    if (!this.endpoint) { this.error.set('Für diese App ist noch kein Server eingerichtet.'); return; }
    this.running.set(true);
    this.error.set(null); this.result.set(null); this.completed.set(0); this.total.set(0);
    const controller = new AbortController();
    this.controller = controller;
    try {
      await this.storage.migrateMetadata();
      const snapshot = await this.readCounts();
      this.total.set(snapshot.pending);
      let afterKey = 0;
      while (true) {
        if (controller.signal.aborted) throw new Error('Cancelled');
        const page = await this.storage.pendingPage(afterKey, snapshot.maxKey);
        if (!page.length) break;
        const groups = new Map<string, PendingMeasurement[]>();
        for (const entry of page) {
          const key = `${entry.measurement.deviceId}:${entry.measurement.source}`;
          const group = groups.get(key) ?? [];
          group.push(entry); groups.set(key, group);
        }
        for (const group of groups.values()) {
          if (controller.signal.aborted) throw new Error('Cancelled');
          const first = group[0].measurement;
          const body = {
            deviceId: first.deviceId, source: first.source,
            measurements: group.map(({ measurement: row }) => ({
              measurementId: row.measurementId, measuredAt: new Date(row.time).toISOString(), ppm: row.ppm, segment: row.segment,
            })),
          };
          const timeout = setTimeout(() => controller.abort(), 15_000);
          try {
            const response = Capacitor.getPlatform() === 'android' ? await this.postNative({
              url: this.endpoint, headers: { 'Content-Type': 'application/json' }, data: body,
              responseType: 'json', connectTimeout: 15_000, readTimeout: 15_000,
            }) : await fetch(this.endpoint, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
            });
            if (response.status !== 200) throw new ServerError(response.status);
            const ack = ('data' in response ? response.data : await response.json()) as { received?: number; inserted?: number; duplicates?: number } | null;
            if (!ack || ack.received !== group.length || !Number.isInteger(ack.inserted) || !Number.isInteger(ack.duplicates) ||
                ack.inserted! < 0 || ack.duplicates! < 0 || ack.inserted! + ack.duplicates! !== ack.received) {
              throw new Error('Invalid acknowledgement');
            }
            if (controller.signal.aborted) throw new Error('Cancelled');
          } finally { clearTimeout(timeout); }
          await this.storage.markSynced(group);
          this.completed.update(value => value + group.length);
          await this.readCounts();
        }
        afterKey = page[page.length - 1].key;
      }
      this.result.set(this.completed() ? `${this.completed()} Messungen synchronisiert.` : 'Keine sendebereiten Messungen vorhanden.');
    } catch (error) {
      this.error.set(error instanceof ServerError && error.status === 409
        ? 'Datenkonflikt mit dem Server. Die betroffenen Messungen bleiben ausstehend.'
        : error instanceof ServerError && error.status === 400
          ? 'Der Server hat den Messwert-Paketinhalt abgelehnt. Die Messungen bleiben ausstehend.'
          : 'Synchronisierung fehlgeschlagen oder Antwort verloren. Nicht bestätigte Messungen bleiben ausstehend. Bitte später erneut manuell versuchen.');
    } finally {
      this.controller = undefined;
      await this.refreshCounts();
      this.running.set(false);
    }
  }

  postNative(options: Parameters<typeof CapacitorHttp.post>[0]) { return CapacitorHttp.post(options); }

  private apiEndpoint(): string | null {
    const native = Capacitor.isNativePlatform();
    const base = native ? this.config.nativeBaseUrl : this.config.browserBaseUrl;
    if (!base) return null;
    if (native) {
      try {
        const url = new URL(base);
        if (this.config.usbDebug && Capacitor.getPlatform() === 'android' && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '5045' && url.pathname === '/api') return base + '/measurements/batch';
        if (!['http:', 'https:'].includes(url.protocol) || /^(localhost|127\..*|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)) return null;
      } catch { return null; }
    }
    return `${base.replace(/\/$/, '')}/measurements/batch`;
  }
}
