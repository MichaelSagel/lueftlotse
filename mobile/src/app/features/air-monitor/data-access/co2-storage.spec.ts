import { afterEach, describe, expect, it, vi } from 'vitest';
import { Co2Storage, Co2Measurement } from './co2-storage';

function databaseHarness(points: Co2Measurement[] = []) {
  const request: { result: unknown; onsuccess: null | (() => void) } = { result: null, onsuccess: null };
  let position = 0;
  const deleted: number[] = [];
  const step = () => {
    const i = position++;
    request.result = i < points.length ? {
      value: points[i], primaryKey: i + 1, continue: vi.fn(() => queueMicrotask(step)), delete: vi.fn(() => { deleted.push(i); }),
    } : null;
    request.onsuccess?.();
  };
  const openCursor = vi.fn(() => { queueMicrotask(step); return request; });
  const store = {
    openCursor,
    add: vi.fn(() => ({ result: points.length + 1 })), clear: vi.fn(), count: vi.fn(() => ({ result: 1000 })),
    openKeyCursor: vi.fn(() => ({ result: { primaryKey: points.length } })),
    index: vi.fn(() => ({ count: vi.fn(() => ({ result: points.length })), openCursor })),
  };
  const metadata = { get: vi.fn(() => {
    const request = { result: 'simulator-id', onsuccess: null as null | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }) };
  const transaction = {
    objectStore: vi.fn((name: string) => name === 'metadata' ? metadata : store), error: null as DOMException | null,
    oncomplete: null as null | (() => void), onabort: null as null | (() => void),
  };
  const database = { transaction: vi.fn(() => transaction), close: vi.fn(), onversionchange: null };
  const openRequest = { result: database, onsuccess: null as null | (() => void), onerror: null, onblocked: null, onupgradeneeded: null };
  vi.stubGlobal('indexedDB', { open: vi.fn(() => { queueMicrotask(() => openRequest.onsuccess?.()); return openRequest; }) });
  vi.stubGlobal('IDBKeyRange', {
    bound: vi.fn((start: number, end: number) => ({ start, end })),
    upperBound: vi.fn((cutoff: number, open: boolean) => ({ cutoff, open })),
  });
  return { store, transaction, database, openCursor, deleted };
}
async function flush() { for (let i = 0; i < 150; i++) await Promise.resolve(); }

describe('Co2Storage IndexedDB transactions', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('streams only the requested bounded range through the time index', async () => {
    const harness = databaseHarness([{ time: 400000, ppm: 650, segment: 'session' }]);
    const storage = new Co2Storage(); const loaded = storage.load(100000, 500000);
    const page = vi.spyOn(storage, 'page').mockResolvedValue({ entries: [{ time: 400000, ppm: 650, segment: 'session' }], next: null });
    await flush();
    expect(harness.store.index).toHaveBeenCalledWith('time');
    harness.transaction.oncomplete!();
    expect(await loaded).toEqual({ count: 1000, rangeCount: 1, entries: [{ time: 400000, ppm: 650, segment: 'session' }] });
    expect(page).toHaveBeenCalledWith(100000, 500000, null, 1000);
    await storage.close(); expect(harness.database.close).toHaveBeenCalled();
  });
  it('waits for transaction commit before reporting success', async () => {
    const harness = databaseHarness(); let completed = false;
    const saved = new Co2Storage().append({ time: 1000, ppm: 650, segment: 'session' }).then(() => { completed = true; });
    await flush(); expect(completed).toBe(false);
    harness.transaction.oncomplete!(); await saved; expect(completed).toBe(true);
  });
  it('propagates quota failures without deleting valid data', async () => {
    const harness = databaseHarness(); const saved = new Co2Storage().append({ time: 1000, ppm: 650, segment: 'session' });
    const assertion = expect(saved).rejects.toMatchObject({ name: 'QuotaExceededError' }); await flush();
    harness.transaction.error = new DOMException('full', 'QuotaExceededError'); harness.transaction.onabort!();
    await assertion; expect(harness.store.clear).not.toHaveBeenCalled();
  });
  it('loads a page incrementally and skips only already displayed duplicate timestamps', async () => {
    const harness = databaseHarness(Array.from({ length: 6 }, (_, i) => ({ time: 1000, ppm: 600 + i, segment: 'one' })));
    const page = new Co2Storage().page(0, 2000, { time: 1000, key: 2 }, 3);
    await flush(); expect(harness.openCursor).toHaveBeenCalledWith({ start: 1000, end: 2000 }, 'next');
    harness.transaction.oncomplete!();
    expect(await page).toEqual({ entries: [602, 603, 604].map(ppm => ({ time: 1000, ppm, segment: 'one' })), next: { time: 1000, key: 5 } });
  });
  it('deletes old entries via an exclusive upper bound on the time index', async () => {
    const harness = databaseHarness([{ time: 999, ppm: 650, segment: 'old' }]);
    const pruned = new Co2Storage().prune(1000); await flush();
    expect(harness.openCursor).toHaveBeenCalledWith({ cutoff: 1000, open: true }); expect(harness.deleted).toEqual([0]);
    harness.transaction.oncomplete!();
    // Complete the three subsequent empty service-store transactions as well.
    for (let i = 0; i < 3; i++) { await flush(); harness.transaction.oncomplete!(); }
    await pruned;
  });

  it('continues bounded batches using a cursor and can cancel obsolete range reads', async () => {
    const harness = databaseHarness(); const storage = new Co2Storage();
    let cancel = false;
    const page = vi.spyOn(storage, 'page')
      .mockResolvedValueOnce({ entries: [{ time: 1000, ppm: 650, segment: 'one' }], next: { time: 1000, key: 1 } })
      .mockImplementationOnce(async () => { cancel = true; return { entries: [], next: { time: 2000, key: 2 } }; });
    const loaded = storage.load(0, 3000, () => cancel);
    const assertion = expect(loaded).rejects.toMatchObject({ name: 'AbortError' });
    await flush(); harness.transaction.oncomplete!(); await assertion;
    expect(page).toHaveBeenNthCalledWith(2, 0, 3000, { time: 1000, key: 1 }, 1000);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('captures a count and highest primary key in one transaction for a stable table snapshot', async () => {
    const harness = databaseHarness([{ time: 1000, ppm: 650, segment: 'one' }]);
    const snapshot = new Co2Storage().tableSnapshot(0, 2000); await flush();
    expect(harness.store.openKeyCursor).toHaveBeenCalledWith(null, 'prev');
    harness.transaction.oncomplete!(); expect(await snapshot).toEqual({ count: 1, maxKey: 1 });
  });

  it('reads newest first, excludes later keys and continues backwards through duplicates', async () => {
    // The harness feeds values in the order returned by the requested descending cursor.
    const harness = databaseHarness(Array.from({ length: 6 }, (_, i) => ({ time: 1000 - i, ppm: 600 + i, segment: 'one' })));
    const page = new Co2Storage().page(0, 2000, { time: 1000, key: 1 }, 2, 'prev', 3); await flush();
    expect(harness.openCursor).toHaveBeenCalledWith({ start: 0, end: 1000 }, 'prev');
    harness.transaction.oncomplete!();
    expect(await page).toEqual({ entries: [{ time: 999, ppm: 601, segment: 'one' }, { time: 998, ppm: 602, segment: 'one' }], next: null });
  });
});
