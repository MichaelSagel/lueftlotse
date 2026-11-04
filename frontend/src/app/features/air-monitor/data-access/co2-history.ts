import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { CO2_SOURCE } from './co2-source';
import { Co2Measurement, Co2Storage, PageCursor } from './co2-storage';
import { HistoryPeriod, HistoryRange, periodStart, retentionStart, validRange } from '../domain/history-range';

export type { Co2Measurement } from './co2-storage';
export type { HistoryPeriod } from '../domain/history-range';

@Injectable()
export class Co2History {
  private readonly storage = inject(Co2Storage);
  readonly measurements = signal<readonly Co2Measurement[]>([]);
  readonly visible = signal(false);
  private tableInitialized = false;
  readonly count = signal(0);
  readonly rangeCount = signal(0);
  readonly error = signal<string | null>(null);
  readonly validation = signal<string | null>(null);
  readonly loading = signal(false);
  readonly clearing = signal(false);
  readonly period = signal<HistoryPeriod>('5m');
  private appliedPeriod: HistoryPeriod = '5m';
  readonly live = signal(true);
  readonly range = signal<HistoryRange>({ start: Date.now() - 300000, end: Date.now() });
  readonly rows = signal<readonly Co2Measurement[]>([]);
  readonly pageNumber = signal(1);
  readonly hasNextPage = signal(false);
  readonly pageSize = signal<10 | 25 | 50>(10);
  readonly tableCount = signal(0);
  readonly tableLoading = signal(false);
  readonly newMeasurements = signal(false);
  readonly tableRange = signal<HistoryRange>(this.range());
  private tableRevision = 0;
  private tableMaxKey = 0;
  // Compare committed database keys with the table snapshot, never wall-clock movement.
  private latestRelevantKey = 0;
  private readonly instance = crypto.randomUUID();
  private segment = 0;
  private destroyed = false;
  private restored = false;
  private revision = 0;
  private refreshPending = false;
  private dataVersion = 0;
  private chartVersion = -1;
  private autoTablePending = false;
  private pageStarts: (PageCursor | null)[] = [null];
  private nextCursor: PageCursor | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly reads = new Set<Promise<void>>();

  constructor() {
    void this.storage.migrateMetadata().catch(error => this.reportError(error));
    void this.enqueue(async () => {
      await this.storage.prune(retentionStart(Date.now()));
      this.count.set(await this.storage.count()); this.restored = true;
    });
    const source = inject(CO2_SOURCE);
    const subscription = source.readings.subscribe(reading => {
      if (source.state().status === 'running') void this.record(reading.ppm, reading.time, source.state().session);
    });
    const timer = setInterval(() => {
      if (this.visible() && this.live() && !this.refreshPending && (source.state().status === 'running' || this.dataVersion !== this.chartVersion)) {
        void this.refresh(true);
      }
    }, 5000);
    const cleanup = setInterval(() => {
      void this.enqueue(async () => {
        await this.storage.prune(retentionStart(Date.now()));
        this.count.set(await this.storage.count());
      });
      if (!this.visible()) return;
      const range = this.range();
      if (range.start < retentionStart(Date.now())) this.setRange({ start: retentionStart(Date.now()), end: Math.max(range.end, retentionStart(Date.now()) + 1) });
      else void this.refresh(true);
    }, 3600000);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      subscription.unsubscribe(); clearInterval(timer); clearInterval(cleanup);
      void this.whenSettled().then(() => this.storage.close()).catch(() => {});
    });
  }
  setVisible(visible: boolean): void {
    if (visible === this.visible()) return;
    this.visible.set(visible);
    if (!visible) {
      this.revision++; this.tableRevision++;
      this.loading.set(false); this.refreshPending = false; this.tableLoading.set(false);
      return;
    }
    void this.refresh(this.chartVersion >= 0);
    if (!this.tableInitialized || (this.live() && this.pageNumber() === 1)) void this.updateTable(true);
    else {
      // Keep the existing table snapshot and page when returning to a past interval.
      this.loadTablePage();
    }
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(operation).catch(error => this.reportError(error));
    return this.queue;
  }
  private reportError(error: unknown): void {
    if (error instanceof DOMException && error.name === 'AbortError') return;
      this.error.set(error instanceof DOMException && error.name === 'QuotaExceededError'
        ? 'Speicher voll. Neue Messungen können nicht gespeichert werden. Messwerte innerhalb der letzten zwei Jahre werden nicht automatisch gelöscht.'
        : 'Verlauf konnte nicht geladen, gespeichert oder gelöscht werden. Bitte prüfe den Browserspeicher und lade die Seite erneut.');
  }
  private read(operation: () => Promise<void>): Promise<void> {
    const request = this.queue.then(operation).catch(error => this.reportError(error));
    this.reads.add(request);
    void request.finally(() => this.reads.delete(request));
    return request;
  }
  async whenSettled(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.queue;
      await Promise.all([pending, ...this.reads]);
    } while (pending !== this.queue || this.reads.size);
  }
  /** Refresh committed imports without feeding the simulator/source reading stream. */
  imported(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return this.enqueue(async () => {
      this.count.set(await this.storage.count()); this.dataVersion++;
      if (!this.visible()) return;
      const range = this.range();
      const key = await this.storage.newestKeyInRange(range.start, this.live() ? Date.now() : range.end, this.tableMaxKey);
      this.latestRelevantKey = Math.max(this.latestRelevantKey, key);
      this.newMeasurements.set(this.latestRelevantKey > this.tableMaxKey);
      void this.refresh(true);
      this.autoUpdateTable();
    });
  }
  beginSegment(): void { this.segment++; }
  record(ppm: number, time = Date.now(), segment = this.segment): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    return this.enqueue(async () => {
      if (!this.restored) {
        this.count.set(await this.storage.count()); this.restored = true;
      }
      const key = await this.storage.append({ ppm, time, segment: `${this.instance}:${segment}` });
      this.count.update(count => count + 1);
      this.dataVersion++;
      const range = this.range();
      if (time >= range.start && (this.live() ? time <= Date.now() : time <= range.end)) {
        this.latestRelevantKey = Math.max(this.latestRelevantKey, key);
        this.newMeasurements.set(this.latestRelevantKey > this.tableMaxKey);
        this.autoUpdateTable();
      }
    });
  }
  refresh(background = false): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.live()) {
      const end = Date.now();
      this.range.set({ start: Math.max(retentionStart(end), this.liveStart(end)), end });
    }
    const range = this.range();
    const revision = ++this.revision;
    if (!background) this.loading.set(true);
    this.refreshPending = true;
    return this.read(async () => {
      try {
        if (revision !== this.revision) return;
        const version = this.dataVersion;
        const result = await this.storage.load(range.start, range.end, () => revision !== this.revision || this.destroyed);
        if (revision !== this.revision || this.destroyed) return;
        this.rangeCount.set(result.rangeCount);
        if (!this.sameMeasurements(this.measurements(), result.entries)) this.measurements.set(result.entries);
        this.chartVersion = version;
      } finally {
        if (revision === this.revision) { this.loading.set(false); this.refreshPending = false; }
      }
    });
  }
  private sameMeasurements(a: readonly Co2Measurement[], b: readonly Co2Measurement[]): boolean {
    return a.length === b.length && a.every((point, i) => point.time === b[i].time && point.ppm === b[i].ppm && point.segment === b[i].segment);
  }
  private autoUpdateTable(): void {
    if (this.destroyed || !this.visible() || !this.live() || this.pageNumber() !== 1 || this.tableLoading() || this.autoTablePending || !this.newMeasurements()) return;
    this.autoTablePending = true;
    const previousKey = this.tableMaxKey;
    void this.updateTable(true).finally(() => {
      this.autoTablePending = false;
      // Retry only after progress; a failed storage request must not create a busy loop.
      if (this.tableMaxKey > previousKey) this.autoUpdateTable();
    });
  }
  private setRange(range: HistoryRange): void {
    this.revision++; this.range.set(range); this.validation.set(null);
    this.measurements.set([]); this.rangeCount.set(0);
    this.latestRelevantKey = 0; this.newMeasurements.set(false);
    void this.refresh();
    void this.updateTable();
  }
  choosePeriod(period: HistoryPeriod): void {
    this.period.set(period);
    if (period !== 'custom') {
      this.appliedPeriod = period;
      this.live.set(true);
      const end = Date.now(); this.setRange({ start: periodStart(end, period), end });
    }
  }
  selectRange(start: number, end: number): boolean {
    if (!validRange({ start, end }, Date.now())) {
      this.validation.set('Bitte wähle einen gültigen Zeitraum innerhalb der letzten zwei Jahre. Beginn muss vor Ende liegen; Ende darf nicht in der Zukunft liegen.');
      return false;
    }
    this.appliedPeriod = 'custom'; this.period.set('custom'); this.live.set(false); this.setRange({ start, end }); return true;
  }
  navigate(direction: -1 | 1): void {
    const { start, end } = this.range(); const width = end - start;
    const now = Date.now(); const earliest = retentionStart(now);
    const shiftedEnd = Math.min(now, Math.max(earliest + width, end + direction * width));
    this.live.set(false); this.setRange({ start: Math.max(earliest, shiftedEnd - width), end: shiftedEnd });
  }
  now(): void {
    const end = Date.now();
    this.live.set(true); this.setRange({ start: Math.max(retentionStart(end), this.liveStart(end)), end });
  }
  private liveStart(end: number): number {
    const period = this.appliedPeriod;
    return period === 'custom' ? end - (this.range().end - this.range().start) : periodStart(end, period);
  }
  changePage(direction: -1 | 1): void {
    if (this.tableLoading()) return;
    if (direction === 1 && this.nextCursor) {
      this.pageStarts[this.pageNumber()] = this.nextCursor;
      this.pageNumber.update(page => page + 1);
    } else if (direction === -1 && this.pageNumber() > 1) this.pageNumber.update(page => page - 1);
    else return;
    this.loadTablePage();
  }
  private loadTablePage(): void {
    const range = this.tableRange(); const revision = ++this.tableRevision;
    const pageNumber = this.pageNumber(); const size = this.pageSize();
    this.tableLoading.set(true);
    void this.read(async () => {
      try {
        if (revision !== this.tableRevision) return;
        const page = await this.storage.page(range.start, range.end, this.pageStarts[pageNumber - 1], size, 'prev', this.tableMaxKey);
        if (revision !== this.tableRevision || this.destroyed) return;
        this.rows.set(page.entries); this.nextCursor = page.next; this.hasNextPage.set(page.next !== null);
      } finally {
        if (revision === this.tableRevision) { this.tableLoading.set(false); this.autoUpdateTable(); }
      }
    });
  }
  changePageSize(size: number): void {
    if (size !== 10 && size !== 25 && size !== 50) return;
    this.pageSize.set(size); void this.updateTable();
  }
  updateTable(background = false): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const current = this.range();
    const end = this.live() ? Date.now() : current.end;
    const range = { start: this.live() ? Math.max(retentionStart(end), this.liveStart(end)) : current.start, end };
    const revision = ++this.tableRevision; const size = this.pageSize();
    if (!background) {
      this.tableRange.set(range); this.pageStarts = [null]; this.pageNumber.set(1);
      this.rows.set([]); this.hasNextPage.set(false); this.tableLoading.set(true);
    }
    return this.read(async () => {
      try {
        if (revision !== this.tableRevision) return;
        const snapshot = await this.storage.tableSnapshot(range.start, range.end);
        if (revision !== this.tableRevision) return;
        const page = await this.storage.page(range.start, range.end, null, size, 'prev', snapshot.maxKey);
        if (revision !== this.tableRevision || this.destroyed) return;
        this.tableMaxKey = snapshot.maxKey; this.tableCount.set(snapshot.count);
        this.tableInitialized = true;
        this.tableRange.set(range); this.pageStarts = [null];
        if (!this.sameMeasurements(this.rows(), page.entries)) this.rows.set(page.entries);
        this.nextCursor = page.next; this.hasNextPage.set(page.next !== null);
        this.newMeasurements.set(this.latestRelevantKey > snapshot.maxKey);
      } finally {
        if (revision === this.tableRevision) { this.tableLoading.set(false); this.autoUpdateTable(); }
      }
    });
  }
  clear(): Promise<void> {
    this.clearing.set(true);
    return this.enqueue(async () => {
      try {
        await this.storage.clear(); this.revision++; this.tableRevision++;
        this.measurements.set([]); this.rows.set([]); this.count.set(0); this.rangeCount.set(0);
        this.pageStarts = [null]; this.pageNumber.set(1); this.nextCursor = null; this.hasNextPage.set(false);
        this.tableCount.set(0); this.tableMaxKey = 0; this.latestRelevantKey = 0; this.newMeasurements.set(false); this.tableLoading.set(false);
        this.loading.set(false); this.refreshPending = false;
        this.error.set(null); this.restored = true; this.beginSegment();
        this.dataVersion++; this.chartVersion = this.dataVersion;
      } finally { this.clearing.set(false); }
    });
  }
}
