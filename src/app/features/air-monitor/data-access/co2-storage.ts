import { Injectable } from '@angular/core';
import { HistoryEnvelope } from '../domain/history-envelope';

export interface Co2Measurement { readonly time: number; readonly ppm: number; readonly segment: string; }
export interface PageCursor { readonly time: number; readonly key: number; }
export interface MeasurementPage { entries: Co2Measurement[]; next: PageCursor | null; }
export interface TableSnapshot { count: number; maxKey: number; }

@Injectable()
export class Co2Storage {
  private database: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('lueftlotse', 1);
        let blocked = false;
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('measurements', { autoIncrement: true });
          store.createIndex('time', 'time');
        };
        request.onsuccess = () => {
          if (blocked) { request.result.close(); return; }
          request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
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
      transaction.oncomplete = () => resolve((request ? request.result : undefined) as T);
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
    return Number(await this.write(store => store.add(point)));
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
    const database = this.database;
    this.database = undefined;
    if (database) (await database).close();
  }
}
