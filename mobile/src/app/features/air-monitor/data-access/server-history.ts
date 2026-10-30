import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { MEASUREMENT_API_CONFIG } from './measurement-api.config';

export interface ServerMeasurement {
  measurementId: string; deviceId: string; source: string; measuredAt: string;
  ppm: number; segment: string; receivedAt: string;
}
export interface ServerHistoryFilters { from: string; to: string; deviceId: string; }
interface Page { items: ServerMeasurement[]; nextCursor: string | null; }
class HistoryError extends Error {}

/** Volatile server view. No storage, local history or BLE dependency. */
@Injectable()
export class ServerHistory {
  private readonly config = inject(MEASUREMENT_API_CONFIG);
  readonly rows = signal<ServerMeasurement[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  private filters?: ServerHistoryFilters;
  private generation = 0;
  private abort?: AbortController;
  constructor() { inject(DestroyRef).onDestroy(() => { this.generation++; this.abort?.abort(); }); }
  setFilters(filters: ServerHistoryFilters): void {
    this.generation++; this.abort?.abort(); this.filters = { ...filters };
    this.rows.set([]); this.nextCursor.set(null); this.loading.set(false); this.loaded.set(false); this.error.set(null);
  }
  private endpoint(): string {
    const native = Capacitor.isNativePlatform();
    const base = native ? this.config.nativeBaseUrl : this.config.browserBaseUrl;
    if (!base) throw new HistoryError('Für diese App ist noch kein Server eingerichtet.');
    if (native) {
      const url = new URL(base);
      const usb = this.config.usbDebug && Capacitor.getPlatform() === 'android' && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '5045' && url.pathname === '/api';
      if (!usb && (!['http:', 'https:'].includes(url.protocol) || /^(localhost|127\..*|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)))
        throw new HistoryError('Die Serveradresse ist für diese App nicht verfügbar.');
    }
    return base.replace(/\/$/, '') + '/measurements';
  }
  async load(more = false): Promise<void> {
    if (this.loading() || (more && !this.nextCursor())) return;
    const generation = ++this.generation;
    this.abort?.abort(); const abort = this.abort = new AbortController();
    const current = () => generation === this.generation;
    this.loading.set(true); this.error.set(null);
    if (!more) { this.rows.set([]); this.nextCursor.set(null); this.loaded.set(false); }
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const f = this.filters;
      const from = new Date(f?.from ?? ''), to = new Date(f?.to ?? '');
      if (!f || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to)
        throw new HistoryError('Bitte einen gültigen Zeitraum wählen: Von muss vor Bis liegen.');
      const deviceId = f.deviceId.trim();
      if (deviceId && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(deviceId)))
        throw new HistoryError('Bitte eine gültige Geräte-UUID eingeben oder das Feld leer lassen.');
      const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), pageSize: '50' });
      if (deviceId) params.set('deviceId', deviceId);
      if (more) params.set('cursor', this.nextCursor()!);
      const url = this.endpoint() + '?' + params;
      const response = Capacitor.getPlatform() === 'android'
        ? await this.getNative({ url, responseType: 'json', connectTimeout: 15000, readTimeout: 15000 })
        : await fetch(url, { signal: abort.signal });
      if (!current()) return;
      if (abort.signal.aborted) throw new HistoryError('Die Anfrage hat zu lange gedauert. Bitte erneut versuchen.');
      if (response.status !== 200) throw new HistoryError(response.status === 400 ? 'Der Server hat Zeitraum, Geräte-ID oder Cursor abgelehnt. Bitte neu laden.' : 'Der Serververlauf konnte nicht geladen werden. Bitte erneut versuchen.');
      const page: Page = 'data' in response ? response.data : await response.json();
      if (!current()) return;
      if (abort.signal.aborted) throw new HistoryError('Die Anfrage hat zu lange gedauert. Bitte erneut versuchen.');
      if (!page || !Array.isArray(page.items) || page.items.length > 50 ||
          (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor)) ||
          page.items.some(row => !row || typeof row.measurementId !== 'string' || typeof row.deviceId !== 'string' ||
            typeof row.source !== 'string' || typeof row.segment !== 'string' ||
            !Number.isInteger(row.ppm) || row.ppm < 1 || row.ppm > 100000 ||
            typeof row.measuredAt !== 'string' || !Number.isFinite(Date.parse(row.measuredAt)) ||
            typeof row.receivedAt !== 'string' || !Number.isFinite(Date.parse(row.receivedAt))))
        throw new HistoryError('Der Server hat eine ungültige Antwort geliefert.');
      this.rows.set(more ? [...this.rows(), ...page.items] : page.items);
      this.nextCursor.set(page.nextCursor); this.loaded.set(true);
    } catch (error) {
      if (current()) this.error.set(error instanceof HistoryError
        ? error.message : 'Der Server ist nicht erreichbar oder die Anfrage wurde unterbrochen. Bitte erneut versuchen.');
    } finally { clearTimeout(timeout); if (current()) this.loading.set(false); }
  }
  getNative(options: Parameters<typeof CapacitorHttp.get>[0]) { return CapacitorHttp.get(options); }
}
