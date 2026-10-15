import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBCursorWithValue } from 'fake-indexeddb';
import { Co2Measurement, Co2Storage, StoredCo2Measurement } from './co2-storage';

type LegacyRow = Co2Measurement & Partial<StoredCo2Measurement>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Persistent measurement metadata in IndexedDB', () => {
  const connections: IDBDatabase[] = [];
  const storages: Co2Storage[] = [];
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  });
  afterEach(async () => {
    for (const storage of storages.splice(0)) await storage.close();
    for (const database of connections.splice(0)) database.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const storage = () => { const result = new Co2Storage(); storages.push(result); return result; };
  function open(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('lueftlotse', version);
      request.onupgradeneeded = () => {
        const measurements = request.result.createObjectStore('measurements', { autoIncrement: true });
        measurements.createIndex('time', 'time');
      };
      request.onsuccess = () => { connections.push(request.result); resolve(request.result); };
      request.onerror = () => reject(request.error);
    });
  }
  function completed(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  }
  async function seed(entries: [number, LegacyRow][]): Promise<void> {
    const database = await open(1);
    const transaction = database.transaction('measurements', 'readwrite');
    for (const [key, row] of entries) transaction.objectStore('measurements').add(row, key);
    await completed(transaction);
    database.close();
  }
  async function snapshot() {
    const database = await open();
    const transaction = database.transaction(['measurements', 'metadata'], 'readonly');
    const store = transaction.objectStore('measurements');
    const keys = store.getAllKeys();
    const values = store.getAll();
    const identity = transaction.objectStore('metadata').get('simulatorDeviceId');
    const progress = transaction.objectStore('metadata').get('measurementMetadataProgress');
    await completed(transaction);
    database.close();
    return {
      version: database.version,
      rows: keys.result.map((key, index) => ({ key, value: values.result[index] as LegacyRow })),
      deviceId: identity.result as string,
      progress: progress.result as { lastKey: number; complete: boolean } | undefined,
    };
  }

  it('upgrades v1 without changing original fields, primary keys, time index or key generator', async () => {
    const legacy: [number, LegacyRow][] = [
      [3, { time: 1700000000000, ppm: 650, segment: 'instance:1' }],
      [17, { time: 1700000000000, ppm: 850, segment: 'instance:2' }],
      [105, { time: 1700000001000, ppm: 2100, segment: 'other:1' }],
    ];
    await seed(legacy);
    const current = storage();
    await current.migrateMetadata();
    const saved = await snapshot();
    expect(saved.version).toBe(2);
    expect(saved.deviceId).toMatch(uuid);
    expect(saved.rows.map(row => row.key)).toEqual([3, 17, 105]);
    saved.rows.forEach((row, index) => {
      expect(row.value).toMatchObject(legacy[index][1]);
      expect(row.value.measurementId).toMatch(uuid);
      expect(row.value).toMatchObject({ deviceId: saved.deviceId, source: 'simulator', syncStatus: 'pending' });
    });
    expect(new Set(saved.rows.map(row => row.value.measurementId)).size).toBe(3);
    const page = await current.page(1700000000000, 1700000001000, null);
    expect(page.entries.map(row => row.ppm)).toEqual([650, 850, 2100]);
    expect(await current.append({ time: 1700000002000, ppm: 900, segment: 'new:1' })).toBe(106);
  });

  it('resumes a large history after a committed batch and application closure', async () => {
    const legacy: [number, LegacyRow][] = Array.from({ length: 1201 }, (_, i) => [
      i * 2 + 1, { time: 1700000000000 + i, ppm: 600 + i, segment: `instance:${i % 3}` },
    ]);
    await seed(legacy);
    const first = storage();
    const batch = first.migrateMetadataBatch.bind(first);
    vi.spyOn(first, 'migrateMetadataBatch').mockImplementationOnce(async () => {
      const done = await batch(100);
      await first.close();
      return done;
    });
    await first.migrateMetadata();
    const interrupted = await snapshot();
    expect(interrupted.rows.filter(row => row.value.measurementId)).toHaveLength(100);
    expect(interrupted.progress).toEqual({ lastKey: 199, complete: false });
    const resumed = storage();
    const batches = vi.spyOn(resumed, 'migrateMetadataBatch');
    await resumed.migrateMetadata();
    expect(batches).toHaveBeenCalledTimes(3);
    const final = await snapshot();
    expect(final.deviceId).toBe(interrupted.deviceId);
    expect(final.rows.slice(0, 100)).toEqual(interrupted.rows.slice(0, 100));
    expect(final.rows.map(row => row.key)).toEqual(legacy.map(([key]) => key));
    expect(new Set(final.rows.map(row => row.value.measurementId)).size).toBe(1201);
    expect(final.rows.every(row => row.value.deviceId === final.deviceId && row.value.syncStatus === 'pending')).toBe(true);
    final.rows.forEach((row, i) => expect(row.value).toMatchObject(legacy[i][1]));
    expect(final.progress).toEqual({ lastKey: 2401, complete: true });
  });

  it('does not allocate or change UUIDs when migration runs again after restart', async () => {
    await seed([[1, { time: 1000, ppm: 650, segment: 'one' }]]);
    const random = vi.spyOn(crypto, 'randomUUID');
    const first = storage(); await first.migrateMetadata();
    const saved = await snapshot();
    const allocations = random.mock.calls.length;
    await first.migrateMetadata();
    await first.close();
    await storage().migrateMetadata();
    expect(await snapshot()).toEqual(saved);
    expect(random).toHaveBeenCalledTimes(allocations);
  });

  it('fills only missing fields in partially migrated records and keeps assigned identifiers', async () => {
    const measurementId = crypto.randomUUID();
    const sensorDeviceId = crypto.randomUUID();
    await seed([
      [1, { time: 1000, ppm: 650, segment: 'one', measurementId }],
      [2, { time: 2000, ppm: 800, segment: 'two', measurementId: crypto.randomUUID(), deviceId: sensorDeviceId, source: 'sensor', syncStatus: 'synced' }],
    ]);
    await storage().migrateMetadata();
    const saved = await snapshot();
    expect(saved.rows[0].value).toMatchObject({ measurementId, deviceId: saved.deviceId, source: 'simulator', syncStatus: 'pending' });
    expect(saved.rows[1].value).toMatchObject({ deviceId: sensorDeviceId, source: 'sensor', syncStatus: 'synced' });
  });

  it('rolls back a failed batch and checkpoint together, preserving earlier committed IDs', async () => {
    await seed(Array.from({ length: 6 }, (_, i) => [i + 1, { time: i, ppm: 650 + i, segment: 'one' }]));
    const current = storage();
    expect(await current.migrateMetadataBatch(2)).toBe(false);
    const committed = await snapshot();
    const update = IDBCursorWithValue.prototype.update;
    const failure = vi.spyOn(IDBCursorWithValue.prototype, 'update').mockImplementation(function (this: IDBCursorWithValue, value) {
      const request = update.call(this, value);
      const transaction = (this.source as IDBObjectStore).transaction;
      request.addEventListener('success', () => transaction.abort());
      return request;
    });
    await expect(current.migrateMetadataBatch(2)).rejects.toThrow();
    failure.mockRestore();
    expect(await snapshot()).toEqual(committed);
    await current.close();
    await storage().migrateMetadata();
    const finished = await snapshot();
    expect(finished.rows.slice(0, 2)).toEqual(committed.rows.slice(0, 2));
    expect(finished.rows.every(row => row.value.measurementId)).toBe(true);
  });

  it('stores new readings with metadata immediately and keeps simulator identity after restart and clear', async () => {
    const first = storage();
    await first.append({ time: 1000, ppm: 650, segment: 'one' });
    const saved = await snapshot();
    const row = saved.rows[0].value;
    expect(row).toMatchObject({ time: 1000, ppm: 650, segment: 'one', deviceId: saved.deviceId, source: 'simulator', syncStatus: 'pending' });
    expect(row.measurementId).toMatch(uuid);
    await first.close();
    const second = storage();
    await second.append({ time: 2000, ppm: 850, segment: 'two' });
    const next = await snapshot();
    expect(next.rows[0].value).toEqual(row);
    expect(next.rows[1].value.deviceId).toBe(saved.deviceId);
    expect(next.rows[1].value.measurementId).not.toBe(row.measurementId);
    await second.clear();
    await second.append({ time: 3000, ppm: 900, segment: 'three' });
    const cleared = await snapshot();
    expect(cleared.deviceId).toBe(saved.deviceId);
    expect(cleared.rows).toHaveLength(1);
    expect(cleared.rows[0].key).toBe(3);
    expect(cleared.rows[0].value.deviceId).toBe(saved.deviceId);
  });

  it('serializes identity allocation for concurrent service instances, migration and new writes', async () => {
    await seed([[5, { time: 1000, ppm: 650, segment: 'old' }]]);
    const first = storage(); const second = storage();
    await Promise.all([
      first.migrateMetadata(), second.migrateMetadata(),
      first.append({ time: 2000, ppm: 700, segment: 'one' }),
      second.append({ time: 3000, ppm: 750, segment: 'two' }),
    ]);
    const saved = await snapshot();
    expect(saved.rows).toHaveLength(3);
    expect(saved.rows.every(row => row.value.deviceId === saved.deviceId)).toBe(true);
    expect(new Set(saved.rows.map(row => row.value.measurementId)).size).toBe(3);
    expect(saved.progress?.complete).toBe(true);
  });

  it('keeps metadata and simulator identity when retention prunes old measurements', async () => {
    await seed([[1, { time: 999, ppm: 650, segment: 'old' }], [2, { time: 1000, ppm: 700, segment: 'kept' }]]);
    const current = storage(); await current.migrateMetadata();
    const saved = await snapshot();
    await current.prune(1000);
    const pruned = await snapshot();
    expect(pruned.deviceId).toBe(saved.deviceId);
    expect(pruned.rows).toEqual(saved.rows.slice(1));
  });
});
