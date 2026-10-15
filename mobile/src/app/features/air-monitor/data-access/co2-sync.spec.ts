import { TestBed } from '@angular/core/testing';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Co2Storage, StoredCo2Measurement } from './co2-storage';
import { Co2Sync } from './co2-sync';
import { MEASUREMENT_API_CONFIG } from './measurement-api.config';

describe('Manual measurement synchronization', () => {
  let storage: Co2Storage;
  let sync: Co2Sync;
  const request = vi.fn<typeof fetch>();
  const success = (received: number, duplicates = 0) => new Response(JSON.stringify({ received, inserted: received - duplicates, duplicates }), { status: 200 });
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('fetch', request);
    request.mockReset();
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    TestBed.configureTestingModule({ providers: [Co2Storage, Co2Sync] });
    storage = TestBed.inject(Co2Storage);
    sync = TestBed.inject(Co2Sync);
  });
  afterEach(async () => {
    TestBed.resetTestingModule();
    await storage.close();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  async function database(): Promise<IDBDatabase> {
    await storage.syncSnapshot();
    return new Promise((resolve, reject) => {
      const opened = indexedDB.open('lueftlotse');
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
  }
  async function seed(count: number): Promise<StoredCo2Measurement[]> {
    const deviceId = crypto.randomUUID();
    const rows: StoredCo2Measurement[] = Array.from({ length: count }, (_, index) => ({
      measurementId: crypto.randomUUID(), deviceId, source: 'simulator', syncStatus: 'pending',
      time: 1700000000000 + index * 1000, ppm: 650 + index, segment: 'session:1',
    }));
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('measurements', 'readwrite');
      for (const row of rows) transaction.objectStore('measurements').add(row);
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return rows;
  }
  async function write(key: number, value: unknown): Promise<void> {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('measurements', 'readwrite');
      transaction.objectStore('measurements').put(value, key);
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }
  async function saved(): Promise<StoredCo2Measurement[]> {
    const db = await database();
    const rows = await new Promise<StoredCo2Measurement[]>((resolve, reject) => {
      const transaction = db.transaction('measurements', 'readonly');
      const get = transaction.objectStore('measurements').getAll();
      transaction.oncomplete = () => resolve(get.result); transaction.onabort = () => reject(transaction.error);
    });
    db.close(); return rows;
  }
  const payload = (index: number) => JSON.parse(request.mock.calls[index][1]!.body as string);

  it('sends at most 100 per request grouped by device and source, preserving identity and local history', async () => {
    const rows = await seed(205);
    rows[1] = { ...rows[1], source: 'sensor' };
    rows[2] = { ...rows[2], deviceId: crypto.randomUUID() };
    await write(2, rows[1]); await write(3, rows[2]);
    await storage.migrateMetadata();
    const random = vi.spyOn(crypto, 'randomUUID');
    request.mockImplementation(async (_, init) => success(JSON.parse(init!.body as string).measurements.length));
    await sync.synchronize();
    const sentIds: string[] = [];
    for (let i = 0; i < request.mock.calls.length; i++) {
      expect(request.mock.calls[i][0]).toBe('/api/measurements/batch');
      const body = payload(i);
      expect(body.measurements.length).toBeLessThanOrEqual(100);
      for (const entry of body.measurements) {
        const original = rows.find(row => row.measurementId === entry.measurementId)!;
        expect(body.deviceId).toBe(original.deviceId); expect(body.source).toBe(original.source);
        expect(entry).toEqual({ measurementId: original.measurementId, measuredAt: new Date(original.time).toISOString(), ppm: original.ppm, segment: original.segment });
        sentIds.push(entry.measurementId);
      }
    }
    expect(new Set(sentIds).size).toBe(205);
    expect(random).not.toHaveBeenCalled();
    expect(await saved()).toEqual(rows.map(row => ({ ...row, syncStatus: 'synced' })));
    expect(sync.completed()).toBe(205); expect(sync.total()).toBe(205);
    expect(sync.counts()).toEqual({ pending: 0, synced: 205 });
    expect(sync.error()).toBeNull(); expect(sync.running()).toBe(false);
    const calls = request.mock.calls.length;
    await sync.synchronize(); expect(request).toHaveBeenCalledTimes(calls);
  });

  it('keeps pending after a lost response and safely resends the same IDs for duplicates', async () => {
    const rows = await seed(3);
    const serverIds = new Set<string>();
    request.mockImplementationOnce(async (_, init) => {
      for (const entry of JSON.parse(init!.body as string).measurements) serverIds.add(entry.measurementId);
      throw new TypeError('Response lost after server commit');
    });
    await sync.synchronize();
    expect((await saved()).every(row => row.syncStatus === 'pending')).toBe(true);
    expect(sync.error()).toContain('Antwort verloren'); expect(request).toHaveBeenCalledTimes(1);
    request.mockImplementationOnce(async (_, init) => {
      const entries = JSON.parse(init!.body as string).measurements;
      expect(entries.every((entry: { measurementId: string }) => serverIds.has(entry.measurementId))).toBe(true);
      return success(entries.length, entries.length);
    });
    await sync.synchronize();
    expect(payload(1)).toEqual(payload(0));
    expect((await saved()).map(row => row.measurementId)).toEqual(rows.map(row => row.measurementId));
    expect(sync.counts()).toEqual({ pending: 0, synced: 3 });
  });

  it.each([400, 409, 500, 503])('stops on HTTP %s without acknowledgement or automatic retry', async status => {
    await seed(150);
    request.mockResolvedValue(new Response('internal details must not reach the UI', { status }));
    await sync.synchronize();
    expect(request).toHaveBeenCalledOnce(); expect(sync.running()).toBe(false);
    expect(sync.counts()).toEqual({ pending: 150, synced: 0 });
    expect(sync.error()).not.toContain('internal details'); expect(sync.error()).toBeTruthy();
    expect(sync.result()).toBeNull();
  });

  it('acknowledges only earlier successful packets when a later packet fails', async () => {
    await seed(150);
    request.mockResolvedValueOnce(success(100)).mockRejectedValueOnce(new TypeError('offline'));
    await sync.synchronize();
    expect(request).toHaveBeenCalledTimes(2);
    const rows = await saved();
    expect(rows.slice(0, 100).every(row => row.syncStatus === 'synced')).toBe(true);
    expect(rows.slice(100).every(row => row.syncStatus === 'pending')).toBe(true);
    expect(sync.completed()).toBe(100); expect(sync.counts()).toEqual({ pending: 50, synced: 100 });
  });

  it.each([{ received: 1, inserted: 0, duplicates: 0 }, { received: 2, inserted: 2, duplicates: 0 }, null])('rejects incomplete acknowledgements: %j', async ack => {
    await seed(1); request.mockResolvedValue(new Response(JSON.stringify(ack), { status: 200 }));
    await sync.synchronize();
    expect(sync.counts()).toEqual({ pending: 1, synced: 0 });
    expect(sync.error()).toBeTruthy(); expect(request).toHaveBeenCalledOnce();
  });

  it('prevents parallel runs and leaves measurements collected during HTTP pending for next time', async () => {
    await seed(1);
    let respond!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const running = sync.synchronize();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await sync.synchronize(); expect(request).toHaveBeenCalledOnce();
    expect(sync.running()).toBe(true); expect(sync.completed()).toBe(0); expect(sync.total()).toBe(1);
    await storage.append({ time: Date.now(), ppm: 850, segment: 'new-session' });
    respond(success(1)); await running;
    expect(request).toHaveBeenCalledOnce();
    expect(sync.counts()).toEqual({ pending: 1, synced: 1 });
    expect((await saved())[1].syncStatus).toBe('pending');
  });

  it('keeps a confirmed-but-unmarked packet pending if local commit fails', async () => {
    await seed(1); request.mockResolvedValue(success(1));
    vi.spyOn(storage, 'markSynced').mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    await sync.synchronize(); expect(sync.counts()).toEqual({ pending: 1, synced: 0 });
    request.mockResolvedValueOnce(success(1, 1));
    await sync.synchronize(); expect(sync.counts()).toEqual({ pending: 0, synced: 1 });
  });

  it('does not resurrect history cleared during HTTP or mark newly collected readings', async () => {
    await seed(1);
    request.mockImplementationOnce(async () => {
      await storage.clear(); await storage.append({ time: Date.now(), ppm: 900, segment: 'new' });
      return success(1);
    });
    await sync.synchronize();
    const rows = await saved(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ppm: 900, syncStatus: 'pending' });
  });

  it('rolls back all local synced flags if the acknowledgement transaction aborts', async () => {
    await seed(3); const entries = await storage.pendingPage(0, 3);
    const put = IDBObjectStore.prototype.put;
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(storage.markSynced(entries)).rejects.toThrow();
    failure.mockRestore();
    expect((await saved()).every(row => row.syncStatus === 'pending')).toBe(true);
  });

  it('reads only pending rows with complete metadata up to the snapshot key', async () => {
    const rows = await seed(5);
    await write(1, { ...rows[0], syncStatus: 'synced' });
    await write(2, { time: rows[1].time, ppm: rows[1].ppm, segment: 'partial', syncStatus: 'pending' });
    const entries = await storage.pendingPage(1, 4);
    expect(entries.map(entry => entry.key)).toEqual([3, 4]);
    expect(await storage.syncSnapshot()).toEqual({ pending: 4, synced: 1, maxKey: 5 });
    await storage.markSynced([entries[0]]);
    expect((await storage.pendingPage(0, 5)).map(entry => entry.key)).toEqual([4, 5]);
  });

  it('does not acknowledge a different measurement now stored under a confirmed key', async () => {
    const rows = await seed(1); const entries = await storage.pendingPage(0, 1);
    await write(1, { ...rows[0], measurementId: crypto.randomUUID() });
    await storage.markSynced(entries);
    expect((await saved())[0].syncStatus).toBe('pending');
  });

  it('upgrades v2 without changing previously assigned IDs and synchronization state', async () => {
    await storage.close();
    vi.stubGlobal('indexedDB', new IDBFactory());
    const legacy = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('lueftlotse', 2);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('measurements', { autoIncrement: true });
        store.createIndex('time', 'time'); request.result.createObjectStore('metadata');
      };
      request.onsuccess = () => resolve(request.result);
    });
    const id = crypto.randomUUID(); const device = crypto.randomUUID();
    await new Promise<void>(resolve => {
      const transaction = legacy.transaction(['measurements', 'metadata'], 'readwrite');
      transaction.objectStore('metadata').put(device, 'simulatorDeviceId');
      transaction.objectStore('measurements').add({ time: 1000, ppm: 650, segment: 'one', measurementId: id, deviceId: device, source: 'simulator', syncStatus: 'synced' }, 8);
      transaction.oncomplete = () => resolve();
    });
    legacy.close(); await storage.migrateMetadata();
    expect(await storage.syncSnapshot()).toEqual({ pending: 0, synced: 1, maxKey: 8 });
    expect((await saved())[0]).toMatchObject({ measurementId: id, deviceId: device, syncStatus: 'synced' });
  });

  it.each([null, '/api', 'http://localhost:5045/api', 'http://127.0.0.1:5045/api', 'http://[::1]:5045/api'])('does not call HTTP on native without a usable server: %s', async nativeBaseUrl => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [Co2Storage, Co2Sync, { provide: MEASUREMENT_API_CONFIG, useValue: { browserBaseUrl: '/api', nativeBaseUrl } }] });
    sync = TestBed.inject(Co2Sync);
    await sync.synchronize();
    expect(sync.endpoint).toBeNull(); expect(request).not.toHaveBeenCalled(); expect(sync.error()).toContain('Server');
  });

  it('does nothing when no pending data exists', async () => {
    await sync.synchronize(); expect(request).not.toHaveBeenCalled(); expect(sync.result()).toContain('Keine');
  });
});
