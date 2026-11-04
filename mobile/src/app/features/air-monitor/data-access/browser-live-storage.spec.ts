import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Co2Storage } from './co2-storage';
import { LiveSample } from './ble-session';

const device = '00112233-4455-4677-8899-aabbccddeeff';
const sample: LiveSample = { type: 0x8a, bootId: device, sampleCounter: 18446744073709551615n, uptimeMs: 18446744073709551615n, ppm: 950 };
describe('browser LIVE_SAMPLE storage', () => {
  let storage: Co2Storage;
  beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); storage = new Co2Storage(); });
  afterEach(async () => { await storage.close(); vi.unstubAllGlobals(); });
  it('commits pending sensor metadata atomically and deduplicates across storage instances', async () => {
    const append = vi.spyOn(storage, 'append');
    expect(await storage.saveLiveSample(device, sample, 1700000000000)).toBe(true);
    const rows = await storage.pendingPage(0, Infinity);
    expect(rows[0].measurement).toMatchObject({ deviceId: device, source: 'sensor', syncStatus: 'pending', sampleCounter: '18446744073709551615', uptimeMs: '18446744073709551615', time: 1700000000000 });
    expect(rows[0].measurement.measurementId).toMatch(/^[0-9a-f-]{36}$/);
    await storage.close(); storage = new Co2Storage();
    expect(await storage.saveLiveSample(device, { ...sample, ppm: 1000 }, 1800000000000)).toBe(false);
    expect(await storage.pendingPage(0, Infinity)).toEqual(rows); expect(append).not.toHaveBeenCalled();
  });
  it('rejects invalid samples without writing and separates device and boot identities', async () => {
    await expect(storage.saveLiveSample(device, { ...sample, ppm: 0 }, Date.now())).rejects.toThrow();
    expect(await storage.count()).toBe(0);
    const other = '11223344-5566-4788-99aa-bbccddeeff00';
    await storage.saveLiveSample(device, sample, Date.now());
    await storage.saveLiveSample(other, sample, Date.now());
    await storage.saveLiveSample(device, { ...sample, bootId: other }, Date.now());
    expect(await storage.count()).toBe(3);
  });
  it.each([6, 7])('preserves history and dedup receipts from schema v%i after reconnect', async version => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('lueftlotse', version);
      r.onupgradeneeded = () => {
        const m = r.result.createObjectStore('measurements', { autoIncrement: true });
        for (const name of ['time', 'syncStatus', 'measurementId']) m.createIndex(name, name, { unique: name === 'measurementId' });
        m.createIndex('deviceSequence', ['deviceId', 'source', 'sequence']);
        for (const name of ['metadata', 'bleCursors', 'bleGaps', 'bleUndatable', 'bleReceipts']) r.result.createObjectStore(name);
        r.transaction!.objectStore('bleGaps').createIndex('deviceId', 'deviceId');
        if (version === 7) r.result.createObjectStore('browserLiveSamples');
      };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const row = { measurementId: crypto.randomUUID(), deviceId: device, source: 'sensor', syncStatus: 'pending', time: 1700000000000, ppm: 950, segment: device };
    const names = Array.from(db.objectStoreNames);
    const tx = db.transaction(names, 'readwrite');
    tx.objectStore('measurements').put(row, 17);
    tx.objectStore(version === 6 ? 'metadata' : 'browserLiveSamples').put(row.measurementId, version === 6 ? ['browserLiveSample', device, device, sample.sampleCounter.toString()] : [device, device, sample.sampleCounter.toString()]);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    expect(await storage.saveLiveSample(device, sample, Date.now())).toBe(false);
    await storage.close(); storage = new Co2Storage(); // Recreated browser session/reconnect.
    expect(await storage.saveLiveSample(device, sample, Date.now())).toBe(false);
    expect(await storage.pendingPage(0, Infinity)).toEqual([{ key: 17, measurement: row }]);
    expect(await storage.count()).toBe(1);
  });

});
