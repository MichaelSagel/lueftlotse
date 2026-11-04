import { decodeBody, encodeBody } from '../ble-protocol/codec';
import { uuidBytes } from '../ble-protocol/binary';
import type { LiveSample } from './ble-session';
import { Injectable } from '@angular/core';
import { HistoryEnvelope } from '../domain/history-envelope';
import { HistoryContinuity } from '../domain/history-continuity';
import { signal } from '@angular/core';
import { prepareTerminalBatch, serviceRecordExpired, TerminalRecord, VerifiedBleBatch } from './ble-terminal-batch';
import { BleCursorConflictError, BleImportConflictError, BleImportResult, BleReadyBatch, prepareReadyBatch, sameSensorMeasurement } from './ble-ready-batch';

export interface Co2Measurement {
  readonly time: number; readonly ppm: number; readonly segment: string;
  readonly deviceId?: string; readonly source?: 'simulator' | 'sensor'; readonly sequence?: string;
}
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

interface ClearState { revision: number; clearing: number; listeners: Set<() => void>; }
const historyClears = new WeakMap<IDBFactory, ClearState>();
const serviceStores = ['bleUndatable', 'bleGaps', 'bleReceipts'] as const;

@Injectable()
export class Co2Storage {
  readonly changes = signal(0);
  private database: Promise<IDBDatabase> | undefined;
  private migration: Promise<void> | undefined;
  private generation = 0;
  private clearState(): ClearState {
    let state = historyClears.get(indexedDB);
    if (!state) { state = { revision: 0, clearing: 0, listeners: new Set() }; historyClears.set(indexedDB, state); }
    return state;
  }
  get historyClearing(): boolean { return this.clearState().clearing > 0; }
  onHistoryCleared(listener: () => void): () => void {
    const state = this.clearState(); state.listeners.add(listener); return () => state.listeners.delete(listener);
  }
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('lueftlotse', 7);
        let blocked = false;
        request.onupgradeneeded = event => {
          if (event.oldVersion < 1) {
            const store = request.result.createObjectStore('measurements', { autoIncrement: true });
            store.createIndex('time', 'time');
          }
          // Keep versionchange short: the history is backfilled in resumable transactions.
          if (event.oldVersion < 2) request.result.createObjectStore('metadata');
          if (event.oldVersion < 3) request.transaction!.objectStore('measurements').createIndex('syncStatus', 'syncStatus');
          if (event.oldVersion < 4) {
            request.transaction!.objectStore('measurements').createIndex('measurementId', 'measurementId', { unique: true });
            request.result.createObjectStore('bleCursors');
          }
          if (event.oldVersion < 5) {
            request.result.createObjectStore('bleUndatable');
            request.result.createObjectStore('bleGaps');
            request.result.createObjectStore('bleReceipts');
          }
          if (event.oldVersion < 6) {
            request.transaction!.objectStore('measurements').createIndex('deviceSequence', ['deviceId', 'source', 'sequence']);
            request.transaction!.objectStore('bleGaps').createIndex('deviceId', 'deviceId');
          }
          if (event.oldVersion < 7) request.result.createObjectStore('browserLiveSamples');
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
    const continuity = new HistoryContinuity((deviceId, left, right) => this.hasConfirmedLoss(deviceId, left, right, cancelled));
    let after: PageCursor | null = null;
    do {
      if (cancelled()) throw new DOMException('Abgebrochen', 'AbortError');
      // Short transactions let pending writes commit between batches.
      const page = await this.page(start, end, after, 1000);
      for (const point of page.entries) {
        if (cancelled()) throw new DOMException('Abgebrochen', 'AbortError');
        envelope.add(await continuity.project(point));
      }
      after = page.next;
    } while (after);
    return { ...totals, entries: envelope.points() };
  }
  private async hasConfirmedLoss(deviceId: string, left: bigint, right: bigint, cancelled: () => boolean): Promise<boolean> {
    const low = (left < right ? left : right) + 1n;
    const high = (left < right ? right : left) - 1n;
    if (low > high) return false;
    let after: IDBValidKey | undefined;
    do {
      if (cancelled()) throw new DOMException('Abgebrochen', 'AbortError');
      const database = await this.open();
      const page = await new Promise<{ gaps: { fromSequence: string; toSequence: string }[]; more: boolean; last?: IDBValidKey }>((resolve, reject) => {
        const tx = database.transaction('bleGaps', 'readonly');
        const request = tx.objectStore('bleGaps').index('deviceId').openCursor(IDBKeyRange.only(deviceId));
        const gaps: { fromSequence: string; toSequence: string }[] = []; let more = false; let last: IDBValidKey | undefined;
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) return;
          if (after !== undefined && indexedDB.cmp(cursor.primaryKey, after) <= 0) {
            if (indexedDB.cmp(cursor.primaryKey, after) < 0) cursor.continuePrimaryKey(deviceId, after); else cursor.continue();
            return;
          }
          if (gaps.length === 128) { more = true; return; }
          gaps.push(cursor.value); last = cursor.primaryKey; cursor.continue();
        };
        tx.oncomplete = () => resolve({ gaps, more, last });
        tx.onabort = () => reject(tx.error ?? new Error('GAP query failed'));
      });
      for (const gap of page.gaps) {
        const from = BigInt(gap.fromSequence); const to = BigInt(gap.toSequence);
        const start = from > low ? from : low; const end = to < high ? to : high;
        if (start <= end && !await this.hasLocalSequenceRange(deviceId, start, end, cancelled)) return true;
      }
      after = page.more ? page.last : undefined;
    } while (after !== undefined);
    return false;
  }
  /** Exact-key jumps on the decimal-string index. Split at digit boundaries: never use numeric sequence casts. */
  private async hasLocalSequenceRange(deviceId: string, start: bigint, end: bigint, cancelled: () => boolean): Promise<boolean> {
    let next = start;
    while (next <= end) {
      if (cancelled()) throw new DOMException('Abgebrochen', 'AbortError');
      const digitEnd = 10n ** BigInt(next.toString().length) - 1n;
      const upper = digitEnd < end ? digitEnd : end;
      const database = await this.open();
      const result = await new Promise<{ next: bigint; missing: boolean }>((resolve, reject) => {
        const tx = database.transaction('measurements', 'readonly');
        const request = tx.objectStore('measurements').index('deviceSequence').openKeyCursor(
          IDBKeyRange.bound([deviceId, 'sensor', next.toString()], [deviceId, 'sensor', upper.toString()]));
        let expected = next; let processed = 0; let missing = false;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || (cursor.key as IDBValidKey[])[2] !== expected.toString()) { missing = true; return; }
          expected++; processed++;
          if (expected <= upper && processed < 256) cursor.continue([deviceId, 'sensor', expected.toString()]);
        };
        tx.oncomplete = () => resolve({ next: expected, missing });
        tx.onabort = () => reject(tx.error ?? new Error('Sequence coverage query failed'));
      });
      if (result.missing) return false;
      next = result.next;
    }
    return true;
  }
  /** Search only keys committed after a table snapshot; no full history allocation. */
  async newestKeyInRange(start: number, end: number, afterKey: number): Promise<number> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('measurements', 'readonly');
      const request = transaction.objectStore('measurements').openCursor(IDBKeyRange.lowerBound(afterKey, true), 'prev');
      let key = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value.time >= start && cursor.value.time <= end) key = Number(cursor.primaryKey);
        else cursor.continue();
      };
      transaction.oncomplete = () => resolve(key);
      transaction.onabort = () => reject(transaction.error ?? new Error('History snapshot failed'));
    });
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
  /** Browser receipt time, never sensor UTC or uptime. Identity survives reconnect/reload. */
  async saveLiveSample(deviceId: string, input: LiveSample, receivedAt: number): Promise<boolean> {
    uuidBytes(deviceId);
    const sample = decodeBody(0x8a, encodeBody(input)) as LiveSample;
    if (!Number.isFinite(receivedAt) || !Number.isFinite(new Date(receivedAt).getTime())) throw new RangeError('Invalid receipt time');
    const id = deviceId.toLowerCase();
    const identity = [id, sample.bootId, sample.sampleCounter.toString()];
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['measurements', 'metadata', 'browserLiveSamples'], 'readwrite');
      const identities = tx.objectStore('browserLiveSamples');
      const existing = identities.get(identity);
      const legacyIdentity = ['browserLiveSample', id, sample.bootId, sample.sampleCounter.toString()];
      const legacy = tx.objectStore('metadata').get(legacyIdentity);
      let inserted = false;
      let checked = 0;
      const continueAfterLookup = () => {
        if (++checked !== 2 || existing.result !== undefined || legacy.result !== undefined) return;
        const measurementId = crypto.randomUUID();
        tx.objectStore('measurements').add({
          measurementId, deviceId: id, source: 'sensor', syncStatus: 'pending',
          time: receivedAt, ppm: sample.ppm, segment: sample.bootId,
          bootId: sample.bootId, sampleCounter: sample.sampleCounter.toString(), uptimeMs: sample.uptimeMs.toString(),
        } satisfies StoredCo2Measurement & { bootId: string; sampleCounter: string; uptimeMs: string });
        identities.add(measurementId, identity);
        tx.objectStore('metadata').add(measurementId, legacyIdentity);
        inserted = true;
      };
      existing.onsuccess = continueAfterLookup;
      legacy.onsuccess = continueAfterLookup;
      tx.oncomplete = () => { if (inserted) this.changes.update(value => value + 1); resolve(inserted); };
      tx.onabort = () => reject(tx.error ?? new Error('LIVE_SAMPLE save failed'));
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
  /** Import already verified READY records without touching the live source/current reading. */
  async importReadyBatch(batch: BleReadyBatch): Promise<BleImportResult> {
    const rows = prepareReadyBatch(batch);
    return this.commitBleBatch(rows.map(row => ({ kind: 'ready', row })), rows[0].deviceId, batch.afterSequence, batch.throughSequence);
  }
  /** Caller verifies digest first. Result counts terminal entries, including GAP/UNDATABLE. */
  async importBleBatch(batch: VerifiedBleBatch, signal?: AbortSignal): Promise<BleImportResult> {
    const records = prepareTerminalBatch(batch);
    const receipt = { batchId: batch.batchId.toLowerCase(), deviceId: batch.deviceId.toLowerCase(), afterSequence: batch.afterSequence.toString(), throughSequence: batch.throughSequence.toString(), count: batch.count, digest: Array.from(batch.digest, n => n.toString(16).padStart(2, '0')).join('') };
    return this.commitBleBatch(records, receipt.deviceId, batch.afterSequence, batch.throughSequence, receipt, signal);
  }
  private async commitBleBatch(records: TerminalRecord[], deviceId: string, after: bigint, through: bigint,
    receipt?: { batchId: string; deviceId: string; afterSequence: string; throughSequence: string; count: number; digest: string }, signal?: AbortSignal): Promise<BleImportResult> {
    signal?.throwIfAborted();
    const state = this.clearState(); const revision = state.revision;
    if (state.clearing) throw new DOMException('History is being cleared', 'AbortError');
    const receivedAt = Date.now();
    const database = await this.open();
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      if (state.clearing || state.revision !== revision) throw new DOMException('History was cleared', 'AbortError');
      const transaction = database.transaction(['measurements', 'bleCursors', 'bleUndatable', 'bleGaps', 'bleReceipts'], 'readwrite');
      const cancel = () => { try { transaction.abort(); } catch { /* Already committed/aborted. */ } };
      signal?.addEventListener('abort', cancel, { once: true });
      const stopOnClear = this.onHistoryCleared(cancel);
      const cleanup = () => { signal?.removeEventListener('abort', cancel); stopOnClear(); };
      const store = transaction.objectStore('measurements');
      const cursors = transaction.objectStore('bleCursors');
      let failure: unknown; let inserted = 0; let duplicates = 0; let cursor = 0n;
      transaction.onabort = () => { cleanup(); reject(failure ?? signal?.reason ?? transaction.error ?? new Error('BLE import aborted')); };
      transaction.oncomplete = () => {
        cleanup();
        if (inserted || cursor < through) this.changes.update(value => value + 1);
        resolve({ inserted, duplicates, cursor: cursor > through ? cursor : through });
      };
      const guard = (operation: () => void) => {
        try { operation(); } catch (error) {
          failure ??= error;
          try { transaction.abort(); } catch { /* An earlier request may already have aborted it. */ }
        }
      };
      const receipts = transaction.objectStore('bleReceipts');
      let knownReceipt = false;
      if (receipt) {
        const previous = receipts.get(receipt.batchId);
        previous.onsuccess = () => guard(() => {
          knownReceipt = previous.result !== undefined;
          if (previous.result && Object.entries(receipt).some(([key, value]) => previous.result[key] !== value)) throw new BleImportConflictError();
        });
      }
      const savedCursor = cursors.get(deviceId);
      savedCursor.onsuccess = () => guard(() => {
        cursor = BigInt(savedCursor.result ?? '0');
        const replay = after < cursor && through <= cursor;
        if (after !== cursor && !replay) throw new BleCursorConflictError();
        let index = 0;
        const next = () => guard(() => {
          if (index === records.length) {
            if (receipt && !knownReceipt && !replay) receipts.put({ ...receipt, receivedAt }, receipt.batchId);
            if (through > cursor) cursors.put(through.toString(), deviceId);
            return;
          }
          const item = records[index++];
          if (item.kind === 'gap') {
            const row = item.row;
            const gaps = transaction.objectStore('bleGaps');
            const key = [deviceId, row.fromSequence, row.toSequence, row.reason];
            const existing = gaps.get(key);
            existing.onsuccess = () => guard(() => {
              if (existing.result) { duplicates++; next(); }
              else {
                if (replay) throw new BleCursorConflictError();
                const added = gaps.add({ ...row, receivedAt }, key); added.onsuccess = () => { inserted++; next(); };
              }
            });
            return;
          }
          const row = item.row;
          const undatable = transaction.objectStore('bleUndatable');
          const readyLookup = store.index('measurementId').get(row.measurementId);
          const undatedLookup = undatable.get(row.measurementId);
          undatedLookup.onsuccess = () => guard(() => {
            const existing = item.kind === 'ready' ? readyLookup.result : undatedLookup.result;
            const opposite = item.kind === 'ready' ? undatedLookup.result : readyLookup.result;
            if (opposite) throw new BleImportConflictError();
            if (existing !== undefined) {
              const same = item.kind === 'ready' ? sameSensorMeasurement(existing, item.row) : Object.entries(row).every(([key, value]) => existing[key] === value);
              if (!same) throw new BleImportConflictError();
              duplicates++; next();
            } else {
              if (replay) throw new BleCursorConflictError();
              const addition = item.kind === 'ready' ? store.add(row) : undatable.add({ ...row, receivedAt }, row.measurementId);
              addition.onsuccess = () => { inserted++; next(); };
            }
          });
        });
        next();
      });
    });
  }
  async bleCursor(deviceId: string): Promise<bigint> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('bleCursors', 'readonly');
      const request = transaction.objectStore('bleCursors').get(deviceId.toLowerCase());
      transaction.oncomplete = () => resolve(BigInt(request.result ?? '0'));
      transaction.onabort = () => reject(transaction.error ?? new Error('BLE cursor read failed'));
    });
  }
  async clear(): Promise<void> {
    const state = this.clearState(); state.revision++; state.clearing++;
    try {
      for (const listener of [...state.listeners]) listener();
      const database = await this.open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['measurements', 'bleCursors', 'browserLiveSamples', ...serviceStores], 'readwrite');
        for (const name of ['measurements', 'bleCursors', 'browserLiveSamples', ...serviceStores]) transaction.objectStore(name).clear();
        transaction.oncomplete = () => { this.changes.update(value => value + 1); resolve(); };
        transaction.onabort = () => reject(transaction.error ?? new Error('History clear failed'));
      });
    } finally { state.clearing--; }
  }
  /** Strict upper bound preserves records exactly at the calendar retention cutoff. */
  async prune(cutoff: number): Promise<void> {
    await this.write(store => {
      const request = store.index('time').openCursor(IDBKeyRange.upperBound(cutoff, true));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    });
    // Primary-key pages avoid loading all service history or a long write transaction.
    // receivedAt is a value field, so this also works with databases created by the v5 draft.
    const firstSeenAt = Date.now();
    for (const name of serviceStores) {
      let after: IDBValidKey | undefined;
      do {
        const database = await this.open();
        const page = await new Promise<{ more: boolean; last?: IDBValidKey }>((resolve, reject) => {
          const tx = database.transaction(name, 'readwrite');
          const request = tx.objectStore(name).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
          let processed = 0; let more = false; let last: IDBValidKey | undefined;
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (processed === 200) { more = true; return; }
            processed++; last = cursor.primaryKey;
            const value = cursor.value;
            if (typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt)) {
              // Legacy v5 lacks reception time: first local observation is explicitly estimated.
              cursor.update({ ...value, receivedAt: firstSeenAt, receivedAtEstimated: true });
            } else if (serviceRecordExpired(value.receivedAt, firstSeenAt)) cursor.delete();
            cursor.continue();
          };
          tx.oncomplete = () => resolve({ more, last });
          tx.onabort = () => reject(tx.error ?? new Error('BLE service retention failed'));
        });
        after = page.more ? page.last : undefined;
      } while (after !== undefined);
    }
  }
  async close(): Promise<void> {
    this.generation++;
    this.migration = undefined;
    const database = this.database;
    this.database = undefined;
    if (database) (await database).close();
  }
}
