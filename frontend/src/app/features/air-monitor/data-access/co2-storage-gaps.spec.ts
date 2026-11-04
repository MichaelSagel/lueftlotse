import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { Co2Storage } from './co2-storage';
import { SensorCo2Measurement } from './ble-ready-batch';

const device = '00112233-4455-4677-8899-aabbccddeeff';
const other = '11112233-4455-4677-8899-aabbccddeeff';
const segment = '22222233-4455-4677-8899-aabbccddeeff';
const sensor = (sequence: bigint, time: number, deviceId = device, ppm = 850): SensorCo2Measurement => ({
  measurementId: crypto.randomUUID(), deviceId, source: 'sensor', syncStatus: 'pending', time, ppm,
  segment, sequence: sequence.toString(), bootId: device, uptimeMs: sequence.toString(),
});
interface Gap { deviceId: string; fromSequence: string; toSequence: string; reason: number; receivedAt: number; }
const gap = (from: bigint, to = from, deviceId = device): Gap => ({ deviceId, fromSequence: from.toString(), toSequence: to.toString(), reason: 1, receivedAt: Date.now() });

describe('Stored BLE GAP history continuity', () => {
  let storage: Co2Storage;
  beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); storage = new Co2Storage(); });
  afterEach(async () => { await storage.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => { const r = indexedDB.open('lueftlotse'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }
  async function seed(rows: SensorCo2Measurement[], gaps: Gap[] = []) {
    await storage.count(); const database = await db();
    try {
      const tx = database.transaction(['measurements', 'bleGaps'], 'readwrite');
      rows.forEach(row => tx.objectStore('measurements').add(row));
      gaps.forEach((row, i) => tx.objectStore('bleGaps').put(row, i));
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    } finally { database.close(); }
  }
  it('breaks a same-device same-segment line at confirmed missing sequences without dating GAP', async () => {
    const rows = [sensor(1n, 1000), sensor(4n, 1100)]; await seed(rows, [gap(2n, 3n)]);
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries.map(point => point.time)).toEqual([1000, 1100]);
    expect(loaded.entries[0].segment).not.toBe(loaded.entries[1].segment);
    expect(loaded.rangeCount).toBe(2); expect(loaded.count).toBe(2);
    expect((await storage.page(900, 1200, null)).entries).toEqual(rows); // Stored segments remain unchanged.
  });
  it('does not break when the complete range is already stored locally', async () => {
    await seed([sensor(1n, 1000), sensor(2n, 1020), sensor(3n, 1040), sensor(4n, 1100)], [gap(2n, 3n)]);
    const loaded = await storage.load(900, 1200);
    expect(new Set(loaded.entries.map(point => point.segment)).size).toBe(1);
  });
  it('checks existing coverage outside the selected time filter without plotting those records', async () => {
    await seed([sensor(1n, 1000), sensor(2n, 100), sensor(3n, 200), sensor(4n, 1100)], [gap(2n, 3n)]);
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries.map(point => point.time)).toEqual([1000, 1100]);
    expect(new Set(loaded.entries.map(point => point.segment)).size).toBe(1); expect(getAll).not.toHaveBeenCalled();
  });
  it('still breaks when only part of a confirmed lost interval is available', async () => {
    await seed([sensor(1n, 1000), sensor(2n, 100), sensor(4n, 200), sensor(5n, 1100)], [gap(2n, 4n)]);
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries[0].segment).not.toBe(loaded.entries[1].segment);
  });
  it('ignores unrelated device/range GAP and does not infer loss just from sequence jumps', async () => {
    await seed([sensor(1n, 1000), sensor(4n, 1100)], [gap(2n, 3n, other), gap(9n, 10n)]);
    const loaded = await storage.load(900, 1200);
    expect(new Set(loaded.entries.map(point => point.segment)).size).toBe(1);
  });
  it('preserves segment breaks even when GAP is fully covered', async () => {
    await seed([sensor(1n, 1000), sensor(2n, 100), { ...sensor(3n, 1100), segment: other }], [gap(2n)]);
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries[0].segment).not.toBe(loaded.entries[1].segment);
  });
  it.each([true, false])('compares uint64 near maximum exactly; locally covered=%s', async covered => {
    const max = (1n << 64n) - 1n;
    const rows = [sensor(max - 3n, 1000), sensor(max, 1100)];
    if (covered) rows.push(sensor(max - 2n, 100), sensor(max - 1n, 200));
    await seed(rows, [gap(max - 2n, max - 1n)]);
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries[0].segment === loaded.entries[1].segment).toBe(covered);
    expect(loaded.entries.map(point => point.sequence)).toEqual([(max - 3n).toString(), max.toString()]);
  });
  it.each([true, false])('handles decimal digit boundaries without confusing 10 and 100; covered=%s', async covered => {
    const rows = [sensor(8n, 1000), sensor(12n, 1100), sensor(9n, 100), sensor(11n, 200), sensor(100n, 300)];
    if (covered) rows.push(sensor(10n, 400));
    await seed(rows, [gap(9n, 11n)]);
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries[0].segment === loaded.entries[1].segment).toBe(covered);
  });
  it('streams beyond one GAP page and preserves a loss across measurement pages and aggregation', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => sensor(BigInt(i + 1), i, device, i === 500 ? 200 : i === 501 ? 4000 : 850));
    rows.push(sensor(1002n, 1000));
    const gaps = Array.from({ length: 128 }, (_, i) => gap(BigInt(2000 + i)));
    gaps.push(gap(1001n)); await seed(rows, gaps);
    // All points fall in one bucket; the loss must survive downsampling.
    const loaded = await storage.load(0, 1000000);
    expect(loaded.entries.length).toBeLessThanOrEqual(960);
    expect(Math.min(...loaded.entries.map(p => p.ppm))).toBe(200);
    expect(Math.max(...loaded.entries.map(p => p.ppm))).toBe(4000);
    expect(new Set(loaded.entries.map(p => p.segment)).size).toBe(loaded.entries.length);
  });
  it('checks long fully covered sequence ranges in short indexed cursor transactions', async () => {
    const rows = [sensor(1n, 1000), sensor(602n, 1100), ...Array.from({ length: 600 }, (_, i) => sensor(BigInt(i + 2), i - 1000))];
    await seed(rows, [gap(2n, 601n)]);
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries[0].segment).toBe(loaded.entries[1].segment);
  });
  it('does not plot undatable records or undated loss marks in an empty time range', async () => {
    await seed([], [gap(1n, 100n)]);
    const database = await db();
    try {
      const tx = database.transaction('bleUndatable', 'readwrite');
      tx.objectStore('bleUndatable').put({ deviceId: device, measurementId: crypto.randomUUID(), sequence: '1', ppm: 1000, receivedAt: Date.now() }, 'undatable');
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    } finally { database.close(); }
    expect(await storage.load(900, 1200)).toEqual({ count: 0, rangeCount: 0, entries: [] });
  });
  it('upgrades v5 indexes over existing records without rewriting fields or keys', async () => {
    const originals = [sensor(1n, 1000), sensor(2n, 100), sensor(3n, 1100)]; const loss = gap(2n);
    originals[1] = { ...originals[1], syncStatus: 'synced' };
    const max = '18446744073709551615';
    const undatable = { deviceId: other, measurementId: crypto.randomUUID(), sequence: max, bootId: device, segment, uptimeMs: '9007199254740993', ppm: 900, receivedAt: Date.now() - 5000 };
    const receipt = { batchId: crypto.randomUUID(), deviceId: device, afterSequence: '0', throughSequence: '3', count: 3, digest: 'ab'.repeat(32), receivedAt: Date.now() - 1000 };
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lueftlotse', 5);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('measurements', { autoIncrement: true });
        store.createIndex('time', 'time'); store.createIndex('syncStatus', 'syncStatus'); store.createIndex('measurementId', 'measurementId', { unique: true });
        for (const name of ['metadata', 'bleCursors', 'bleGaps', 'bleUndatable', 'bleReceipts']) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = old.transaction(['measurements', 'bleGaps', 'bleCursors', 'metadata', 'bleUndatable', 'bleReceipts'], 'readwrite');
    originals.forEach((row, i) => tx.objectStore('measurements').put(row, [3, 17, 105][i]));
    tx.objectStore('bleGaps').put(loss, [device, '2', '2', 1]);
    tx.objectStore('bleCursors').put('3', device); tx.objectStore('bleCursors').put(max, other);
    tx.objectStore('metadata').put(other, 'simulatorDeviceId');
    tx.objectStore('bleUndatable').put(undatable, undatable.measurementId); tx.objectStore('bleReceipts').put(receipt, receipt.batchId);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); old.close();
    const loaded = await storage.load(900, 1200);
    expect(loaded.entries[0].segment).toBe(loaded.entries[1].segment); // Existing seq=2 outside the filter covers GAP.
    const expected = {
      measurements: { keys: [3, 17, 105], values: originals },
      bleGaps: { keys: [[device, '2', '2', 1]], values: [loss] },
      bleUndatable: { keys: [undatable.measurementId], values: [undatable] },
      bleReceipts: { keys: [receipt.batchId], values: [receipt] },
      bleCursors: { keys: [device, other], values: ['3', max] },
      metadata: { keys: ['simulatorDeviceId'], values: [other] },
    };
    async function inspect() {
      await storage.count(); const database = await db();
      try {
        expect(database.version).toBe(6);
        expect(Array.from(database.objectStoreNames)).toEqual(Object.keys(expected).sort());
        const names = Object.keys(expected); const read = database.transaction(names, 'readonly');
        const requests = names.map(name => ({ keys: read.objectStore(name).getAllKeys(), values: read.objectStore(name).getAll() }));
        const measurements = read.objectStore('measurements');
        expect(Array.from(measurements.indexNames)).toEqual(['deviceSequence', 'measurementId', 'syncStatus', 'time']);
        const index = measurements.index('deviceSequence');
        expect(index.keyPath).toEqual(['deviceId', 'source', 'sequence']); expect(index.unique).toBe(false); expect(index.multiEntry).toBe(false);
        expect(measurements.index('measurementId').unique).toBe(true);
        const gaps = read.objectStore('bleGaps').index('deviceId');
        expect(gaps.keyPath).toBe('deviceId'); expect(gaps.unique).toBe(false); expect(gaps.multiEntry).toBe(false);
        const indexedPoint = index.get([device, 'sensor', '2']); const indexedGaps = gaps.count(device);
        await new Promise<void>((resolve, reject) => { read.oncomplete = () => resolve(); read.onabort = () => reject(read.error); });
        expect(indexedPoint.result).toEqual(originals[1]); expect(indexedGaps.result).toBe(1);
        const snapshot = Object.fromEntries(names.map((name, i) => [name, { keys: requests[i].keys.result, values: requests[i].values.result }]));
        expect(snapshot).toEqual(expected); return snapshot;
      } finally { database.close(); }
    }
    const migrated = await inspect();
    await storage.close(); storage = new Co2Storage();
    expect(await inspect()).toEqual(migrated);
    expect(await storage.bleCursor(device)).toBe(3n);
    expect(await storage.bleCursor(other)).toBe(BigInt(max));
  });
});
