import { Injectable } from '@angular/core';
import { HistoryEnvelope } from '../domain/history-envelope';
import { signal } from '@angular/core';

export interface Co2Measurement { readonly time: number; readonly ppm: number; readonly segment: string; }
/** History projections can still be read while legacy rows are being upgraded. */
export interface StoredCo2Measurement extends Co2Measurement {
  readonly measurementId: string;
  readonly deviceId: string;
  readonly source: 'simulator' | 'sensor';
  readonly syncStatus: 'pending' | 'synced';
}
interface MetadataProgress { lastKey: number; complete: boolean; }
export interface PendingMeasurement { key: number; measurement: StoredCo2Measurement; }
export interface SyncSnapshot { pending: number; synced: number; maxKey: number; }
export interface PageCursor { readonly time: number; readonly key: number; }
export interface MeasurementPage { entries: Co2Measurement[]; next: PageCursor | null; }
export interface TableSnapshot { count: number; maxKey: number; }

@Injectable()
export class Co2Storage {
  readonly changes = signal(0);
  private database: Promise<IDBDatabase> | undefined;
  private migration: Promise<void> | undefined;
  private generation = 0;
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('lueftlotse', 3);
        let blocked = false;
        request.onupgradeneeded = event => {
          if (event.oldVersion < 1) {
            const store = request.result.createObjectStore('measurements', { autoIncrement: true });
            store.createIndex('time', 'time');
          }
          // Keep versionchange short: the history is backfilled in resumable transactions.
          if (event.oldVersion < 2) request.result.createObjectStore('metadata');
          if (event.oldVersion < 3) request.transaction!.objectStore('measurements').createIndex('syncStatus', 'syncStatus');
        };
        request.onsuccess = () => {
          if (blocked) { request.result.close(); return; }
          request.result.onversionchange = () => {
            request.result.close(); this.database = undefined; this.generation++;
          };
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => { blocked = true; reject(new Error('Datenbank blockiert')); };
      }).catch(error => { this.database = undefined; throw error; });
    }
    return this.database;
  }
  private async write<T = void>(execute: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readwrite');
      transaction.oncomplete = () => { this.changes.update(value => value + 1); resolve((request ? request.result : undefined) as T); };
      transaction.onabort = () => reject(transaction.error ?? new Error('Transaktion abgebrochen'));
      const request = execute(transaction.objectStore('measurements'));
    });
  }
  async count(): Promise<number> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const request = transaction.objectStore('measurements').count();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Anzahl konnte nicht geladen werden'));
    });
  }
  async load(start: number, end: number, cancelled = () => false): Promise<{ count: number; rangeCount: number; entries: Co2Measurement[] }> {
    const database = await this.open();
    const totals = await new Promise<{ count: number; rangeCount: number }>((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const store = transaction.objectStore('measurements');
      const index = store.index('time');
      const range = IDBKeyRange.bound(start, end);
      const count = store.count();
      const rangeCount = index.count(range);
      transaction.oncomplete = () => resolve({ count: count.result, rangeCount: rangeCount.result });
      transaction.onabort = () => reject(transaction.error ?? new Error('Verlauf konnte nicht geladen werden'));
    });
    const envelope = new HistoryEnvelope(start, end);
    let after: PageCursor | null = null;
    do {
      if (cancelled()) throw new DOMException('Abgebrochen', 'AbortError');
      // Short transactions let pending writes commit between batches.
      const page = await this.page(start, end, after, 1000);
      for (const point of page.entries) envelope.add(point);
      after = page.next;
    } while (after);
    return { ...totals, entries: envelope.points() };
  }
  async tableSnapshot(start: number, end: number): Promise<TableSnapshot> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const store = transaction.objectStore('measurements');
      const count = store.index('time').count(IDBKeyRange.bound(start, end));
      const last = store.openKeyCursor(null, 'prev');
      transaction.oncomplete = () => resolve({ count: count.result, maxKey: Number(last.result?.primaryKey ?? 0) });
      transaction.onabort = () => reject(transaction.error ?? new Error('Tabellenstand konnte nicht geladen werden'));
    });
  }
  async page(start: number, end: number, after: PageCursor | null, size = 50, direction: IDBCursorDirection = 'next', maxKey = Infinity): Promise<MeasurementPage> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const index = transaction.objectStore('measurements').index('time');
      const reverse = direction === 'prev';
      const request = index.openCursor(IDBKeyRange.bound(
        reverse ? start : Math.max(start, after?.time ?? start),
        reverse ? Math.min(end, after?.time ?? end) : end,
      ), direction);
      const entries: Co2Measurement[] = [];
      let last: PageCursor | null = null;
      let more = false;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const point: Co2Measurement = cursor.value;
        const key = Number(cursor.primaryKey);
        if (key > maxKey || (after && point.time === after.time && (reverse ? key >= after.key : key <= after.key))) { cursor.continue(); return; }
        if (entries.length === size) { more = true; return; }
        entries.push(point);
        last = { time: point.time, key };
        cursor.continue();
      };
      transaction.oncomplete = () => resolve({ entries, next: more ? last : null });
      transaction.onabort = () => reject(transaction.error ?? new Error('Messungen konnten nicht geladen werden'));
    });
  }
  async append(point: Co2Measurement): Promise<number> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['measurements', 'metadata'], 'readwrite');
      let request: IDBRequest<IDBValidKey>;
      transaction.oncomplete = () => { this.changes.update(value => value + 1); resolve(Number(request.result)); };
      transaction.onabort = () => reject(transaction.error ?? new Error('Messung konnte nicht gespeichert werden'));
      this.withSimulatorId(transaction.objectStore('metadata'), deviceId => {
        const measurement: StoredCo2Measurement = {
          ...point, measurementId: crypto.randomUUID(), deviceId, source: 'simulator', syncStatus: 'pending',
        };
        request = transaction.objectStore('measurements').add(measurement);
      });
    });
  }
  /** Call at startup without delaying normal history reads/writes until the whole backfill ends. */
  migrateMetadata(): Promise<void> {
    if (!this.migration) {
      const generation = this.generation;
      const run = async () => {
        while (generation === this.generation) {
          if (await this.migrateMetadataBatch()) return;
          // Each batch commits before the next transaction, allowing UI and new writes to run.
        }
      };
      const pending = run().finally(() => { if (this.migration === pending) this.migration = undefined; });
      this.migration = pending;
    }
    return this.migration;
  }
  /** Rows and the checkpoint commit together; a crash can only roll back the current batch. */
  async migrateMetadataBatch(size = 500): Promise<boolean> {
    if (!Number.isInteger(size) || size < 1 || size > 500) throw new RangeError('Invalid migration batch size');
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['measurements', 'metadata'], 'readwrite');
      const metadata = transaction.objectStore('metadata');
      const store = transaction.objectStore('measurements');
      let complete = false;
      transaction.oncomplete = () => { this.changes.update(value => value + 1); resolve(complete); };
      transaction.onabort = () => reject(transaction.error ?? new Error('Metadaten konnten nicht gespeichert werden'));
      this.withSimulatorId(metadata, deviceId => {
        const checkpoint = metadata.get('measurementMetadataProgress');
        checkpoint.onsuccess = () => {
          const progress = checkpoint.result as MetadataProgress | undefined;
          if (progress?.complete) { complete = true; return; }
          let lastKey = progress?.lastKey ?? 0;
          let processed = 0;
          const cursor = store.openCursor(IDBKeyRange.lowerBound(lastKey, true));
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row || processed === size) {
              complete = !row;
              metadata.put({ lastKey, complete } satisfies MetadataProgress, 'measurementMetadataProgress');
              return;
            }
            const point = row.value as Co2Measurement & Partial<StoredCo2Measurement>;
            if (point.measurementId === undefined || point.deviceId === undefined || point.source === undefined || point.syncStatus === undefined) {
              row.update({
                ...point,
                measurementId: point.measurementId ?? crypto.randomUUID(),
                deviceId: point.deviceId ?? deviceId,
                source: point.source ?? 'simulator',
                syncStatus: point.syncStatus ?? 'pending',
              } satisfies StoredCo2Measurement);
            }
            lastKey = Number(row.primaryKey);
            processed++;
            row.continue();
          };
        };
      });
    });
  }
  private withSimulatorId(metadata: IDBObjectStore, use: (deviceId: string) => void): void {
    const request = metadata.get('simulatorDeviceId');
    request.onsuccess = () => {
      const deviceId: string = request.result ?? crypto.randomUUID();
      if (request.result === undefined) metadata.put(deviceId, 'simulatorDeviceId');
      use(deviceId);
    };
  }
  async syncSnapshot(): Promise<SyncSnapshot> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const store = transaction.objectStore('measurements');
      const count = store.count();
      const synced = store.index('syncStatus').count('synced');
      const last = store.openKeyCursor(null, 'prev');
      transaction.oncomplete = () => resolve({ pending: count.result - synced.result, synced: synced.result, maxKey: Number(last.result?.primaryKey ?? 0) });
      transaction.onabort = () => reject(transaction.error ?? new Error('Synchronisierungsstand konnte nicht geladen werden'));
    });
  }
  async pendingPage(afterKey: number, maxKey: number): Promise<PendingMeasurement[]> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const request = transaction.objectStore('measurements').index('syncStatus').openCursor(IDBKeyRange.only('pending'));
      const entries: PendingMeasurement[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || Number(cursor.primaryKey) > maxKey || entries.length === 100) return;
        const key = Number(cursor.primaryKey);
        if (key <= afterKey) { cursor.continuePrimaryKey('pending', afterKey + 1); return; }
        const row = cursor.value as Partial<StoredCo2Measurement>;
        if (row.measurementId && row.deviceId && (row.source === 'simulator' || row.source === 'sensor') &&
            typeof row.time === 'number' && typeof row.ppm === 'number' && typeof row.segment === 'string') {
          entries.push({ key, measurement: row as StoredCo2Measurement });
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort = () => reject(transaction.error ?? new Error('Ausstehende Messungen konnten nicht geladen werden'));
    });
  }
  /** Acknowledge only this exact snapshot; never recreate rows deleted during HTTP. */
  async markSynced(entries: readonly PendingMeasurement[]): Promise<void> {
    if (entries.length > 100) throw new RangeError('Invalid acknowledgement size');
    await this.write(store => {
      for (const entry of entries) {
        const request = store.get(entry.key);
        request.onsuccess = () => {
          const current = request.result as StoredCo2Measurement | undefined;
          const sent = entry.measurement;
          if (current?.syncStatus === 'pending' && current.measurementId === sent.measurementId &&
              current.deviceId === sent.deviceId && current.source === sent.source && current.time === sent.time &&
              current.ppm === sent.ppm && current.segment === sent.segment) {
            store.put({ ...current, syncStatus: 'synced' } satisfies StoredCo2Measurement, entry.key);
          }
        };
      }
    });
  }
  clear(): Promise<void> { return this.write(store => { store.clear(); }); }
  /** Strict upper bound keeps measurements exactly at the retention boundary. */
  prune(cutoff: number): Promise<void> {
    return this.write(store => {
      const request = store.index('time').openCursor(IDBKeyRange.upperBound(cutoff, true));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    });
  }
  async close(): Promise<void> {
    this.generation++;
    this.migration = undefined;
    const database = this.database;
    this.database = undefined;
    if (database) (await database).close();
  }
}
