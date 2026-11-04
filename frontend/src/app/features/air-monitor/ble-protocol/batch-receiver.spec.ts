import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { Co2Storage } from '../data-access/co2-storage';
import { batchDigest, Entry } from './codec';
import { BatchAck, BatchReceiver, BatchTransport } from './batch-receiver';
import { serviceRecordExpired } from '../data-access/ble-terminal-batch';
import { retentionStart } from '../domain/history-range';

const deviceId = '00112233-4455-4677-8899-aabbccddeeff';
const ready = (sequence: bigint): Extract<Entry, { tag: 1 }> => ({ tag: 1, sequence, measurementId: crypto.randomUUID(), bootId: deviceId, segmentId: deviceId, uptimeMs: 9007199254740993n, utcMs: 1700000000000n, ppm: 850 });
class FakeTransport implements BatchTransport {
  readonly acks: BatchAck[] = [];
  loseNext = false;
  onSend: (() => Promise<void>) | undefined;
  async commitAndSend(ack: BatchAck, commit: () => Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await commit();
    signal.throwIfAborted(); await this.onSend?.(); signal.throwIfAborted();
    if (this.loseNext) { this.loseNext = false; throw new Error('ACK lost'); }
    this.acks.push(ack);
  }
}
describe('BLE batch receiver with real IndexedDB transactions', () => {
  let storage: Co2Storage; let transport: FakeTransport; let receiver: BatchReceiver;
  let now = 0;
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    storage = new Co2Storage(); transport = new FakeTransport(); now = 0;
    receiver = new BatchReceiver(deviceId, storage, transport, () => now);
  });
  afterEach(async () => { receiver.dispose(); await storage.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function packet(entries: Entry[], afterSequence = 0n, batchId = crypto.randomUUID()) {
    const last = entries[entries.length - 1];
    const begin = { type: 0x82, requestId: 1, batchId, afterSequence, throughSequence: last.tag === 3 ? last.toSequence : last.sequence, count: entries.length } as const;
    const end = { type: 0x84, batchId, digest: await batchDigest(begin, entries) } as const;
    return { begin, entries, end };
  }
  async function receive(p: Awaited<ReturnType<typeof packet>>, target = receiver) {
    await target.receive(p.begin);
    for (const entry of p.entries) await target.receive({ type: 0x83, batchId: p.begin.batchId, entry });
    await target.receive(p.end);
  }
  async function snapshot() {
    await storage.count();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('lueftlotse'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const names = ['measurements', 'bleUndatable', 'bleGaps', 'bleReceipts', 'bleCursors'];
      const tx = db.transaction(names, 'readonly');
      const requests = names.map(name => tx.objectStore(name).getAll());
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      return Object.fromEntries(names.map((name, index) => [name, requests[index].result]));
    } finally { db.close(); }
  }
  async function expectEmpty() {
    expect(await storage.count()).toBe(0); expect(await storage.bleCursor(deviceId)).toBe(0n);
    const data = await snapshot(); for (const records of Object.values(data)) expect(records).toEqual([]);
    expect(transport.acks).toEqual([]);
  }
  it('exposes an awaitable completion that rejects on interruption and timeout', async () => {
    const p = await packet([ready(1n)]);
    await receiver.receive(p.begin);
    const interrupted = expect(receiver.completion).rejects.toThrow('connection closed');
    receiver.disconnect(); await interrupted;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await receiver.receive(p.begin);
    const expired = expect(receiver.completion).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(30000); await expired;
    expect(transport.acks).toEqual([]);
    expect(receiver.bufferedEntries).toBe(0);
  });
  it('commits READY/UNDATABLE/GAP and receipt atomically, then sends exact ACK', async () => {
    const undatable = { ...ready(2n), tag: 2 } as Entry;
    const p = await packet([ready(1n), undatable, { tag: 3, fromSequence: 3n, toSequence: 5n, reason: 1 }]);
    transport.onSend = async () => {
      expect(await storage.bleCursor(deviceId)).toBe(5n);
      const db = await snapshot(); expect(db['measurements']).toHaveLength(1); expect(db['bleUndatable']).toHaveLength(1);
      expect(db['bleGaps']).toHaveLength(1); expect(db['bleReceipts']).toHaveLength(1);
      expect(db['bleUndatable'][0].uptimeMs).toBe('9007199254740993');
      expect(db['bleUndatable'][0]).not.toHaveProperty('time');
    };
    await receive(p);
    await expect(receiver.completion).resolves.toBeUndefined();
    expect(transport.acks).toEqual([{ type: 4, batchId: p.begin.batchId, throughSequence: 5n, count: 3, digest: p.end.digest }]);
    expect(await storage.syncSnapshot()).toMatchObject({ pending: 1, synced: 0 });
  });
  it('does not call import or ACK before complete validation and rejects corrupted digest', async () => {
    const imported = vi.spyOn(storage, 'importBleBatch'); const p = await packet([ready(1n)]);
    await receiver.receive(p.begin); await receiver.receive({ type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] });
    expect(imported).not.toHaveBeenCalled(); expect(transport.acks).toEqual([]);
    p.end.digest[0] ^= 1;
    await expect(receiver.receive(p.end)).rejects.toThrow('digest');
    expect(imported).not.toHaveBeenCalled(); await expectEmpty();
  });
  it('discards an interrupted packet and accepts a fresh transfer after reconnect', async () => {
    const p = await packet([ready(1n)]);
    await receiver.receive(p.begin); receiver.disconnect();
    await expect(receiver.receive(p.end)).rejects.toThrow(); await expectEmpty();
    await receive(p); expect(await storage.bleCursor(deviceId)).toBe(1n);
  });
  it('times out at 30 seconds without extending the deadline for new entries', async () => {
    const p = await packet([ready(1n)]); await receiver.receive(p.begin);
    now = 29999; await receiver.receive({ type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] });
    now = 30000; await expect(receiver.receive(p.end)).rejects.toThrow('deadline'); await expectEmpty();
  });
  it('releases abandoned packet memory on its timer without further input', async () => {
    const p = await packet([ready(1n)]); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await receiver.receive(p.begin); await receiver.receive({ type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] });
    expect(receiver.bufferedEntries).toBe(1); vi.advanceTimersByTime(30000);
    expect(receiver.bufferedEntries).toBe(0); expect(receiver.lastError).toBeTruthy();
    vi.useRealTimers(); await expectEmpty();
  });
  it.each(['measurement', 'cursor', 'receipt', 'undatable', 'gap'])('rolls back all stores when %s persistence fails', async failure => {
    const p = await packet([ready(1n), { ...ready(2n), tag: 2 } as Entry, { tag: 3, fromSequence: 3n, toSequence: 5n, reason: 1 }]);
    const target = { measurement: 'measurements', cursor: 'bleCursors', receipt: 'bleReceipts', undatable: 'bleUndatable', gap: 'bleGaps' }[failure];
    const add = IDBObjectStore.prototype.add; const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
      if (this.name === target) throw new DOMException('Storage full', 'QuotaExceededError'); return add.call(this, value, key);
    });
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
      if (this.name === target) throw new DOMException('Storage full', 'QuotaExceededError'); return put.call(this, value, key);
    });
    await expect(receive(p)).rejects.toThrow(); await expectEmpty();
  });
  it('repeats after a lost ACK without duplicates, preserving synced and the cursor', async () => {
    const p = await packet([ready(1n), { ...ready(2n), tag: 2 } as Entry, { tag: 3, fromSequence: 3n, toSequence: 4n, reason: 2 }]);
    transport.loseNext = true; await expect(receive(p)).rejects.toThrow('ACK lost');
    expect(await storage.bleCursor(deviceId)).toBe(4n); expect(transport.acks).toEqual([]);
    await storage.markSynced(await storage.pendingPage(0, 100)); const saved = await snapshot();
    receiver.dispose(); await storage.close(); storage = new Co2Storage();
    receiver = new BatchReceiver(deviceId, storage, transport, () => now);
    await receive(p); expect(await snapshot()).toEqual(saved); expect(transport.acks).toHaveLength(1);
    const newPacket = await packet(p.entries); await receive(newPacket);
    expect((await snapshot())['measurements']).toEqual(saved['measurements']);
    expect(await storage.syncSnapshot()).toMatchObject({ synced: 1, pending: 0 });
  });
  it('aborts an in-flight IndexedDB transaction on disconnect before commit', async () => {
    const p = await packet([ready(1n)]); const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = add.call(this, value, key);
      if (this.name === 'measurements') request.addEventListener('success', () => receiver.disconnect());
      return request;
    });
    await expect(receive(p)).rejects.toThrow(); await expectEmpty();
  });
  it.each(['wrong ID', 'duplicate', 'order', 'count', 'bounds', 'extra begin', 'early end'])('rejects %s without import or ACK', async issue => {
    const p = await packet([ready(1n), ready(2n)]); await receiver.receive(p.begin);
    const first = { type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] } as const;
    if (issue === 'duplicate') { await receiver.receive(first); await expect(receiver.receive(first)).rejects.toThrow(); }
    else if (issue === 'order') await expect(receiver.receive({ ...first, entry: p.entries[1] })).rejects.toThrow();
    else if (issue === 'wrong ID') await expect(receiver.receive({ ...first, batchId: crypto.randomUUID() })).rejects.toThrow();
    else if (issue === 'bounds') await expect(receiver.receive({ ...first, entry: { tag: 3, fromSequence: 1n, toSequence: 3n, reason: 1 } })).rejects.toThrow();
    else if (issue === 'extra begin') await expect(receiver.receive(p.begin)).rejects.toThrow();
    else if (issue === 'early end') await expect(receiver.receive(p.end)).rejects.toThrow();
    else {
      for (const entry of p.entries) await receiver.receive({ ...first, entry });
      await expect(receiver.receive({ ...first, entry: ready(3n) })).rejects.toThrow();
    }
    await expectEmpty();
  });
  it('rejects oversized count before buffering and clears all terminal metadata with history', async () => {
    const p = await packet([{ tag: 3, fromSequence: 1n, toSequence: 200n, reason: 1 }]);
    await expect(receiver.receive({ ...p.begin, count: 101 })).rejects.toThrow(); expect(receiver.bufferedEntries).toBe(0);
    await receive(p); await storage.clear(); await expectEmptyAfterClear();
    async function expectEmptyAfterClear() { const data = await snapshot(); for (const rows of Object.values(data)) expect(rows).toEqual([]); }
  });
  it('rejects mutated content or receipt under the same identity without partial changes', async () => {
    const first = ready(1n); const undatable = { ...ready(2n), tag: 2 } as Entry;
    const p = await packet([first, undatable]); await receive(p); const before = await snapshot();
    const conflicting = await packet([{ ...first, ppm: 900 }, undatable], 0n, p.begin.batchId);
    await expect(receive(conflicting)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
    expect(transport.acks).toHaveLength(1);
    const secondConflict = await packet([first, { ...undatable, ppm: 900 } as Entry]);
    await expect(receive(secondConflict)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
  });
  it('does not let an old asynchronous digest completion cancel a new connection batch', async () => {
    const p = await packet([ready(1n)]); const fresh = await packet([ready(1n)]);
    let finish!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await receiver.receive(p.begin); await receiver.receive({ type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] });
    const old = receiver.receive(p.end); const rejected = expect(old).rejects.toThrow();
    receiver.disconnect(); await receiver.receive(fresh.begin);
    finish(new Uint8Array(p.end.digest).buffer); await rejected;
    expect(await storage.bleCursor(deviceId)).toBe(0n); expect(transport.acks).toHaveLength(0);
    await receiver.receive({ type: 0x83, batchId: fresh.begin.batchId, entry: fresh.entries[0] });
    await receiver.receive(fresh.end); expect(transport.acks).toHaveLength(1);
  });
  it('upgrades v4 preserving measurement keys, sync status and a uint64 cursor', async () => {
    const previousCursor = 9007199254740993n;
    const simulatorId = crypto.randomUUID(); const otherDevice = crypto.randomUUID();
    const old = [
      { measurementId: crypto.randomUUID(), deviceId: simulatorId, source: 'simulator', syncStatus: 'synced', time: 1700000000000, ppm: 650, segment: 'old' },
      { measurementId: crypto.randomUUID(), deviceId: simulatorId, source: 'simulator', syncStatus: 'pending', time: 1700000001000, ppm: 1100, segment: 'second' },
      { measurementId: crypto.randomUUID(), deviceId: otherDevice, source: 'sensor', syncStatus: 'synced', time: 1700000001000, ppm: 2200, segment: deviceId, sequence: '5', bootId: deviceId, uptimeMs: '9007199254740993' },
    ];
    const keys = [3, 17, 105];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('lueftlotse', 4);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('measurements', { autoIncrement: true });
        store.createIndex('time', 'time'); store.createIndex('syncStatus', 'syncStatus'); store.createIndex('measurementId', 'measurementId', { unique: true });
        request.result.createObjectStore('metadata'); request.result.createObjectStore('bleCursors');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['measurements', 'bleCursors', 'metadata'], 'readwrite');
    old.forEach((row, index) => tx.objectStore('measurements').put(row, keys[index]));
    tx.objectStore('bleCursors').put(previousCursor.toString(), deviceId); tx.objectStore('bleCursors').put('5', otherDevice);
    tx.objectStore('metadata').put(simulatorId, 'simulatorDeviceId');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); }); db.close();
    async function inspect() {
      await storage.count();
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('lueftlotse'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        expect(db.version).toBe(6);
        expect(Array.from(db.objectStoreNames)).toEqual(['bleCursors', 'bleGaps', 'bleReceipts', 'bleUndatable', 'measurements', 'metadata']);
        const tx = db.transaction(['measurements', 'bleCursors', 'metadata', 'bleGaps', 'bleUndatable', 'bleReceipts'], 'readonly');
        const store = tx.objectStore('measurements');
        expect(Array.from(store.indexNames)).toEqual(['deviceSequence', 'measurementId', 'syncStatus', 'time']);
        expect(store.index('measurementId').unique).toBe(true);
        expect(store.index('deviceSequence').keyPath).toEqual(['deviceId', 'source', 'sequence']);
        expect(store.index('deviceSequence').unique).toBe(false); expect(store.index('deviceSequence').multiEntry).toBe(false);
        expect(tx.objectStore('bleGaps').index('deviceId').keyPath).toBe('deviceId');
        expect(tx.objectStore('bleGaps').index('deviceId').unique).toBe(false);
        const indexedSensor = store.index('deviceSequence').get([otherDevice, 'sensor', '5']);
        const services = ['bleGaps', 'bleUndatable', 'bleReceipts'].map(name => tx.objectStore(name).getAll());
        const rows = store.getAll(); const rowKeys = store.getAllKeys();
        const cursorKeys = tx.objectStore('bleCursors').getAllKeys(); const cursorValues = tx.objectStore('bleCursors').getAll();
        const identity = tx.objectStore('metadata').get('simulatorDeviceId');
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        expect(rows.result).toEqual(old); expect(rowKeys.result).toEqual(keys); expect(identity.result).toBe(simulatorId);
        expect(indexedSensor.result).toEqual(old[2]); services.forEach(request => expect(request.result).toEqual([]));
        expect(Object.fromEntries(cursorKeys.result.map((key, i) => [String(key), cursorValues.result[i]]))).toEqual({ [deviceId]: previousCursor.toString(), [otherDevice]: '5' });
        return { rows: rows.result, keys: rowKeys.result, cursorKeys: cursorKeys.result, cursorValues: cursorValues.result, identity: identity.result };
      } finally { db.close(); }
    }
    const migrated = await inspect();
    receiver.dispose(); await storage.close(); storage = new Co2Storage();
    receiver = new BatchReceiver(deviceId, storage, transport, () => now);
    expect(await inspect()).toEqual(migrated);
    await receive(await packet([{ ...ready(previousCursor + 1n), tag: 2 } as Entry], previousCursor));
    const saved = await snapshot(); expect(saved['measurements']).toEqual(old);
    expect(await storage.bleCursor(deviceId)).toBe(previousCursor + 1n);
    expect(await storage.bleCursor(otherDevice)).toBe(5n);
    expect(await storage.append({ time: 1700000001000, ppm: 900, segment: 'new' })).toBe(106);
    expect((await snapshot())['measurements'][3].deviceId).toBe(simulatorId);
  });
  it('keeps first receivedAt on repeats without inventing measurement time for UNDATABLE', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(2024, 1, 28, 12).getTime());
    const p = await packet([ready(1n), { ...ready(2n), tag: 2 } as Entry, { tag: 3, fromSequence: 3n, toSequence: 4n, reason: 1 }]);
    await receive(p); const first = await snapshot();
    for (const name of ['bleUndatable', 'bleGaps', 'bleReceipts']) expect(first[name][0].receivedAt).toBe(Date.now());
    expect(first['bleUndatable'][0]).not.toHaveProperty('time'); expect(first['bleUndatable'][0]).not.toHaveProperty('utcMs');
    clock.mockReturnValue(new Date(2025, 1, 28, 12).getTime());
    await receive(p); expect(await snapshot()).toEqual(first);
  });
  it('expires service history by reception anniversary while preserving device cursors and simulator identity', async () => {
    const receivedAt = new Date(2024, 1, 29, 12).getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(receivedAt);
    await storage.append({ time: receivedAt, ppm: 650, segment: 'sim' }); const simulatorId = (await snapshot())['measurements'][0].deviceId;
    const p = await packet([{ ...ready(1n), tag: 2 } as Entry, { tag: 3, fromSequence: 2n, toSequence: 3n, reason: 2 }]);
    await receive(p);
    const anniversary = new Date(2026, 1, 28, 12).getTime();
    clock.mockReturnValue(anniversary); await storage.prune(retentionStart(Date.now()));
    expect((await snapshot())['bleReceipts']).toHaveLength(1); // Exact boundary is retained.
    clock.mockReturnValue(anniversary + 1); await storage.prune(retentionStart(Date.now()));
    const expired = await snapshot();
    for (const name of ['bleUndatable', 'bleGaps', 'bleReceipts']) expect(expired[name]).toEqual([]);
    expect(await storage.bleCursor(deviceId)).toBe(3n);
    await storage.append({ time: Date.now(), ppm: 700, segment: 'sim-new' });
    expect((await snapshot())['measurements'].at(-1).deviceId).toBe(simulatorId);
    await storage.clear(); expect(await storage.bleCursor(deviceId)).toBe(0n);
    await storage.append({ time: Date.now(), ppm: 750, segment: 'sim-after-clear' });
    expect((await snapshot())['measurements'][0].deviceId).toBe(simulatorId);
  });
  it('handles calendar expiry before/at/after leap-day anniversaries', () => {
    const leap = new Date(2024, 1, 29, 10, 30).getTime(); const anniversary = new Date(2026, 1, 28, 10, 30).getTime();
    expect(serviceRecordExpired(leap, anniversary - 1)).toBe(false);
    expect(serviceRecordExpired(leap, anniversary)).toBe(false);
    expect(serviceRecordExpired(leap, anniversary + 1)).toBe(true);
    const regular = new Date(2023, 5, 15, 8).getTime();
    expect(serviceRecordExpired(regular, new Date(2025, 5, 15, 8).getTime() + 1)).toBe(true);
  });
  it('replays READY after receipt expiry without recreating its TTL, decreasing cursor or overwriting conflicts', async () => {
    const receivedAt = new Date(2024, 2, 1, 12).getTime(); const clock = vi.spyOn(Date, 'now').mockReturnValue(receivedAt);
    const first = { ...ready(1n), utcMs: BigInt(receivedAt + 1000) }; const p = await packet([first]);
    await receive(p); await storage.markSynced(await storage.pendingPage(0, 100));
    clock.mockReturnValue(new Date(2026, 2, 1, 12).getTime() + 1);
    await storage.prune(retentionStart(Date.now()));
    expect((await snapshot())['bleReceipts']).toEqual([]); const saved = await snapshot();
    await receive(p); expect(await snapshot()).toEqual(saved); expect(await storage.bleCursor(deviceId)).toBe(1n);
    expect((await snapshot())['measurements'][0].syncStatus).toBe('synced');
    const conflict = await packet([{ ...first, ppm: first.ppm + 1 }], 0n, p.begin.batchId);
    await expect(receive(conflict)).rejects.toThrow(); expect(await snapshot()).toEqual(saved);
    expect(transport.acks).toHaveLength(2);
  });
  it('cancels collection on full clear across storage instances and prevents stale END from repopulating history', async () => {
    const p = await packet([ready(1n)]); await receiver.receive(p.begin);
    await receiver.receive({ type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] });
    const other = new Co2Storage();
    try { await other.clear(); } finally { await other.close(); }
    await expect(receiver.receive(p.end)).rejects.toThrow(); await expectEmpty();
    await receive(await packet([ready(1n)])); expect(await storage.bleCursor(deviceId)).toBe(1n);
  });
  it('cancels a digest already running when history is cleared', async () => {
    const p = await packet([ready(1n)]); let finish!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await receiver.receive(p.begin); await receiver.receive({ type: 0x83, batchId: p.begin.batchId, entry: p.entries[0] });
    const end = receiver.receive(p.end); const rejected = expect(end).rejects.toThrow();
    await storage.clear(); finish(new Uint8Array(p.end.digest).buffer); await rejected; await expectEmpty();
  });
  it('rolls back commit racing with clear and sends no ACK', async () => {
    const p = await packet([ready(1n)]); let clearing: Promise<void> | undefined;
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, value, key) {
      const request = add.call(this, value, key);
      if (this.name === 'measurements') request.addEventListener('success', () => { clearing = storage.clear(); });
      return request;
    });
    await expect(receive(p)).rejects.toThrow(); await clearing; await expectEmpty();
  });
  it('clears an already committed packet while cancelling a not-yet-sent ACK', async () => {
    const p = await packet([ready(1n)]);
    transport.onSend = async () => { expect(await storage.bleCursor(deviceId)).toBe(1n); await storage.clear(); };
    await expect(receive(p)).rejects.toThrow(); await expectEmpty();
  });
  it('prunes service rows in bounded cursor pages and initializes missing legacy reception time once', async () => {
    const firstSeen = new Date(2026, 5, 15, 12).getTime(); const clock = vi.spyOn(Date, 'now').mockReturnValue(firstSeen);
    await storage.count();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('lueftlotse'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = db.transaction('bleReceipts', 'readwrite'); const receipts = tx.objectStore('bleReceipts');
      for (let i = 0; i < 401; i++) receipts.put({ batchId: String(i), receivedAt: new Date(2022, 5, 15).getTime() }, i);
      receipts.put({ batchId: 'legacy-no-receivedAt' }, 'legacy');
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    } finally { db.close(); }
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    await storage.prune(retentionStart(Date.now())); expect(getAll).not.toHaveBeenCalled(); getAll.mockRestore();
    const saved = (await snapshot())['bleReceipts'];
    expect(saved).toEqual([{ batchId: 'legacy-no-receivedAt', receivedAt: firstSeen, receivedAtEstimated: true }]);
    clock.mockReturnValue(firstSeen + 1000); await storage.prune(retentionStart(Date.now()));
    expect((await snapshot())['bleReceipts']).toEqual(saved);
    clock.mockReturnValue(new Date(2028, 5, 15, 12).getTime() + 1); await storage.prune(retentionStart(Date.now()));
    expect((await snapshot())['bleReceipts']).toEqual([]);
  });
});
