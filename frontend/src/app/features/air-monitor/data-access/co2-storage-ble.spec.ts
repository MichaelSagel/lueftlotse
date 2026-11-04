import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { Co2Storage } from './co2-storage';
import { BleCursorConflictError, BleImportConflictError, BleReadyBatch, SensorCo2Measurement } from './ble-ready-batch';
import { ReadyEntry } from '../ble-protocol/codec';
import { TestBed } from '@angular/core/testing';
import { Co2Simulator } from './co2-simulator';

describe('Atomic BLE READY import', () => {
  let storage: Co2Storage;
  const connections: IDBDatabase[] = [];
  const deviceId = '00112233-4455-4677-8899-aabbccddeeff';
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    storage = new Co2Storage();
  });
  afterEach(async () => { TestBed.resetTestingModule(); await storage.close(); connections.splice(0).forEach(db => db.close()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const entry = (sequence: bigint): ReadyEntry => ({ tag: 1, sequence, measurementId: crypto.randomUUID(), bootId: deviceId, segmentId: deviceId, uptimeMs: (1n << 64n) - 1n, utcMs: 1700000000000n, ppm: 850 });
  const packet = (entries: readonly ReadyEntry[], afterSequence = 0n): BleReadyBatch => ({ deviceId, afterSequence, throughSequence: entries[entries.length - 1].sequence, entries });
  async function open(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('lueftlotse', version);
      request.onsuccess = () => { connections.push(request.result); resolve(request.result); };
      request.onerror = () => reject(request.error);
    });
  }
  const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  async function saved(): Promise<SensorCo2Measurement[]> {
    const db = await open(); const tx = db.transaction('measurements', 'readonly');
    const request = tx.objectStore('measurements').getAll(); await done(tx); db.close(); return request.result;
  }
  async function rawWrite(store: string, value: unknown, key: IDBValidKey): Promise<void> {
    const db = await open(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); await done(tx); db.close();
  }
  it('persists device identities, device segment and lossless uint64 metadata across restart', async () => {
    const record = entry(1n);
    expect(await storage.importReadyBatch(packet([record]))).toEqual({ inserted: 1, duplicates: 0, cursor: 1n });
    expect(await saved()).toEqual([{
      measurementId: record.measurementId, deviceId, source: 'sensor', syncStatus: 'pending',
      time: 1700000000000, ppm: 850, segment: deviceId, sequence: '1', bootId: deviceId, uptimeMs: '18446744073709551615',
    }]);
    await storage.close(); storage = new Co2Storage();
    expect(await storage.bleCursor(deviceId)).toBe(1n);
    const max = (1n << 64n) - 1n;
    await rawWrite('bleCursors', (max - 1n).toString(), deviceId);
    await storage.importReadyBatch(packet([entry(max)], max - 1n));
    expect(await storage.bleCursor(deviceId)).toBe(max);
    expect((await saved())[1].sequence).toBe('18446744073709551615');
  });
  it('does not publish imported history as a current source reading', async () => {
    TestBed.configureTestingModule({ providers: [Co2Simulator] });
    const source = TestBed.inject(Co2Simulator); const current = source.current();
    const readings = vi.fn(); const subscription = source.readings.subscribe(readings);
    try {
      await storage.importReadyBatch(packet([entry(1n)]));
      expect(source.current()).toBe(current); expect(readings).not.toHaveBeenCalled();
    } finally { subscription.unsubscribe(); }
  });
  it('replays without duplicates or resetting synced, even after cursor advancement', async () => {
    const first = packet([entry(1n), entry(2n)]);
    await storage.importReadyBatch(first);
    await storage.markSynced(await storage.pendingPage(0, 2));
    await storage.importReadyBatch(packet([entry(3n)], 2n));
    const before = await saved(); const changes = storage.changes();
    expect(await storage.importReadyBatch(first)).toEqual({ inserted: 0, duplicates: 2, cursor: 3n });
    expect(await saved()).toEqual(before); expect(storage.changes()).toBe(changes);
    expect(await storage.bleCursor(deviceId)).toBe(3n);
    expect(await storage.syncSnapshot()).toMatchObject({ synced: 2, pending: 1 });
  });
  it.each(['ppm', 'utcMs', 'segmentId', 'bootId', 'uptimeMs'] as const)('rolls back the entire packet on conflicting %s', async field => {
    const first = entry(1n); const existing = entry(3n);
    await storage.importReadyBatch(packet([first]));
    // A live reading may already exist ahead of the history cursor.
    const row: SensorCo2Measurement = { measurementId: existing.measurementId, deviceId, source: 'sensor', syncStatus: 'synced', time: Number(existing.utcMs), ppm: existing.ppm, segment: existing.segmentId, bootId: existing.bootId, sequence: '3', uptimeMs: existing.uptimeMs.toString() };
    await rawWrite('measurements', row, 2);
    const changed = { ...existing };
    if (field === 'ppm') changed.ppm++;
    else if (field === 'utcMs') changed.utcMs++;
    else if (field === 'uptimeMs') changed.uptimeMs--;
    else changed[field] = crypto.randomUUID();
    const before = await saved(); const version = storage.changes();
    await expect(storage.importReadyBatch(packet([entry(2n), changed], 1n))).rejects.toBeInstanceOf(BleImportConflictError);
    expect(await saved()).toEqual(before); expect(await storage.bleCursor(deviceId)).toBe(1n);
    expect(storage.changes()).toBe(version);
  });
  it('rolls back inserted rows when the cursor write aborts, preserving the previous cursor', async () => {
    await storage.importReadyBatch(packet([entry(1n)])); const before = await saved();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === 'bleCursors') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(storage.importReadyBatch(packet([entry(2n)], 1n))).rejects.toThrow();
    expect(await saved()).toEqual(before); expect(await storage.bleCursor(deviceId)).toBe(1n);
  });
  it('serializes concurrent repeats across storage instances without double insertion', async () => {
    const other = new Co2Storage();
    try {
      const batch = packet([entry(1n), entry(2n)]);
      const results = await Promise.all([storage.importReadyBatch(batch), other.importReadyBatch(batch)]);
      expect(results.map(r => r.inserted).sort()).toEqual([0, 2]); expect(await saved()).toHaveLength(2);
      expect(await other.bleCursor(deviceId)).toBe(2n);
    } finally { await other.close(); }
  });
  it('rejects gaps, invalid bounds, overlapping cursor advances and non-READY entries', async () => {
    await expect(storage.importReadyBatch(packet([entry(2n)]))).rejects.toThrow();
    await storage.importReadyBatch(packet([entry(1n)]));
    await expect(storage.importReadyBatch(packet([entry(1n), entry(2n)]))).rejects.toBeInstanceOf(BleCursorConflictError);
    await expect(storage.importReadyBatch({ ...packet([entry(2n)], 1n), throughSequence: 3n })).rejects.toThrow();
    await expect(storage.importReadyBatch({ deviceId, afterSequence: 1n, throughSequence: 2n, entries: [{ tag: 2 } as unknown as ReadyEntry] })).rejects.toThrow();
    expect(await storage.bleCursor(deviceId)).toBe(1n); expect(await saved()).toHaveLength(1);
  });
  it('detects identity collisions with simulator records and across devices', async () => {
    await storage.append({ time: 1700000000000, ppm: 850, segment: deviceId });
    const simulator = (await saved())[0];
    await expect(storage.importReadyBatch(packet([{ ...entry(1n), measurementId: simulator.measurementId }]))).rejects.toBeInstanceOf(BleImportConflictError);
    expect(await storage.bleCursor(deviceId)).toBe(0n);
    const first = entry(1n); await storage.importReadyBatch(packet([first]));
    const otherDevice = crypto.randomUUID();
    await expect(storage.importReadyBatch({ ...packet([first]), deviceId: otherDevice })).rejects.toBeInstanceOf(BleImportConflictError);
    expect(await storage.bleCursor(otherDevice)).toBe(0n);
  });
  it('clears device cursors with history while preserving simulator identity', async () => {
    await storage.append({ time: 1700000000000, ppm: 850, segment: 'sim' }); const simulatorDevice = (await saved())[0].deviceId;
    const batch = packet([entry(1n)]); await storage.importReadyBatch(batch);
    await storage.clear(); expect(await storage.bleCursor(deviceId)).toBe(0n); expect(await saved()).toEqual([]);
    await storage.importReadyBatch(batch); expect(await storage.bleCursor(deviceId)).toBe(1n);
    await storage.append({ time: 1700000001000, ppm: 900, segment: 'sim2' }); expect((await saved())[1].deviceId).toBe(simulatorDevice);
  });
  it('upgrades v3 non-destructively and continues the original numeric key generator', async () => {
    const simulator = { measurementId: crypto.randomUUID(), deviceId: crypto.randomUUID(), source: 'simulator', syncStatus: 'synced', time: 1700000000000, ppm: 650, segment: 'old' };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lueftlotse', 3);
      request.onupgradeneeded = () => { const store = request.result.createObjectStore('measurements', { autoIncrement: true }); store.createIndex('time', 'time'); store.createIndex('syncStatus', 'syncStatus'); request.result.createObjectStore('metadata'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['measurements', 'metadata'], 'readwrite'); tx.objectStore('measurements').put(simulator, 17); tx.objectStore('metadata').put(simulator.deviceId, 'simulatorDeviceId'); await done(tx); db.close();
    await storage.importReadyBatch(packet([entry(1n)]));
    expect((await saved())[0]).toEqual(simulator);
    expect(await storage.append({ time: 1700000001000, ppm: 700, segment: 'new' })).toBe(19);
    expect(await storage.syncSnapshot()).toMatchObject({ pending: 2, synced: 1 });
    const upgraded = await open(); expect(upgraded.version).toBe(6);
    expect(upgraded.transaction('measurements').objectStore('measurements').index('measurementId').unique).toBe(true);
  });
});
