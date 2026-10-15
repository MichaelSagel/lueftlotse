import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../../app.routes';
import { CO2_SOURCE } from './co2-source';
import { Co2History } from './co2-history';
import { testStorage } from './co2-storage.testing';
import { retentionStart } from '../domain/history-range';

 describe('Persistent CO₂ history', () => {
  let store: ReturnType<typeof testStorage>;
  function openHistory() { const history = TestBed.inject(Co2History); history.setVisible(true); return history; }
  beforeEach(() => {
    vi.useFakeTimers(); store = testStorage();
    TestBed.configureTestingModule({ providers: [...routes[0].providers!, store.provider] });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('saves all readings, loads the selected window and preserves its graph while stopped', async () => {
    const history = openHistory(); const now = Date.now();
    for (let i = 0; i < 400; i++) await history.record(650 + i, now - (399 - i) * 1000);
    await history.refresh();
    expect(store.rows).toHaveLength(400); expect(history.count()).toBe(400);
    expect(history.rangeCount()).toBe(301); expect(history.measurements().length).toBeLessThanOrEqual(960);
    await history.updateTable(); expect(history.rows()).toHaveLength(10);
    const points = history.measurements(); await vi.advanceTimersByTimeAsync(305000); await history.whenSettled();
    expect(history.measurements()).toBe(points); expect(history.count()).toBe(400);
  });

  it('restores count and recent readings without loading old readings; reloads break continuity', async () => {
    const now = Date.now();
    store.rows.push({ time: now - 400000, ppm: 500, segment: 'old' }, { time: now - 1000, ppm: 700, segment: 'old' });
    const history = openHistory(); await history.whenSettled();
    expect(history.count()).toBe(2); expect(history.measurements()).toHaveLength(1);
    expect(store.storage.load).toHaveBeenCalledWith(history.range().start, history.range().end, expect.any(Function));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [...routes[0].providers!, store.provider] });
    const restored = openHistory(); await restored.whenSettled();
    await restored.record(800, now); await restored.refresh();
    expect(restored.count()).toBe(3);
    expect(restored.measurements()[1].segment).not.toBe(restored.measurements()[0].segment);
  });

  it('preserves history during pause and starts a new segment on resume', async () => {
    const history = openHistory(); const source = TestBed.inject(CO2_SOURCE);
    await history.whenSettled(); source.start();
    await vi.advanceTimersByTimeAsync(5000); await history.refresh();
    const saved = [...store.rows]; source.stop();
    await vi.advanceTimersByTimeAsync(10000); await history.whenSettled(); expect(history.count()).toBe(5);
    source.start(); await vi.advanceTimersByTimeAsync(5000); await history.refresh();
    expect(store.rows.slice(0, 5)).toEqual(saved);
    expect(store.rows[5].segment).not.toBe(saved[4].segment);
  });

  it('serializes deletion before new readings without stopping the source', async () => {
    const history = openHistory(); const source = TestBed.inject(CO2_SOURCE);
    source.start(); await vi.advanceTimersByTimeAsync(2000); await history.whenSettled();
    const deletion = history.clear(); vi.advanceTimersByTime(1000);
    await deletion; await history.whenSettled();
    expect(source.state().status).toBe('running'); expect(history.count()).toBe(1); expect(store.rows).toHaveLength(1);
  });

  it.each(['QuotaExceededError', 'UnknownError'])('reports %s without deleting valid retained data', async name => {
    const history = openHistory(); await history.record(650);
    store.storage.append.mockRejectedValueOnce(new DOMException('failed', name)); await history.record(700);
    expect(history.count()).toBe(1); expect(store.rows).toHaveLength(1);
    expect(history.error()).toContain(name === 'QuotaExceededError' ? 'Speicher voll' : 'Verlauf konnte nicht');
    expect(store.storage.clear).not.toHaveBeenCalled();
  });

  it('keeps the history if deletion fails', async () => {
    const history = openHistory(); await history.record(650); await history.refresh();
    store.storage.clear.mockRejectedValueOnce(new Error('failed')); await history.clear();
    expect(history.count()).toBe(1); expect(history.measurements()).toHaveLength(1);
    expect(history.clearing()).toBe(false); expect(history.error()).not.toBeNull();
  });

  it('recovers the count after an initial read failure', async () => {
    store.rows.push({ time: Date.now(), ppm: 650, segment: 'previous' });
    store.storage.load.mockRejectedValueOnce(new Error('unavailable'));
    const history = openHistory(); await history.whenSettled();
    expect(history.error()).not.toBeNull(); expect(history.loading()).toBe(false);
    await history.record(700); await history.refresh(); expect(history.count()).toBe(2);
  });

  it('selects arbitrary past ranges and keeps them fixed when new measurements arrive', async () => {
    const now = Date.now(); const start = new Date(now).setMonth(new Date(now).getMonth() - 18);
    store.rows.push({ time: start + 1000, ppm: 820, segment: 'old' });
    const history = openHistory(); await history.whenSettled();
    expect(history.selectRange(start, start + 3600000)).toBe(true); await history.whenSettled();
    const selection = history.range(); const points = history.measurements();
    const source = TestBed.inject(CO2_SOURCE); source.start();
    await vi.advanceTimersByTimeAsync(10000); await history.whenSettled();
    expect(history.range()).toEqual(selection); expect(history.measurements()).toBe(points);
    expect(history.rangeCount()).toBe(1); expect(history.count()).toBe(11);
    expect(store.storage.load).toHaveBeenLastCalledWith(selection.start, selection.end, expect.any(Function));
  });

  it('navigates by interval width, clamps retention boundaries and returns to live now', async () => {
    const history = openHistory(); await history.whenSettled();
    for (const [period, width] of [['5m', 300000], ['1h', 3600000], ['24h', 86400000]] as const) {
      history.choosePeriod(period); await history.whenSettled(); const initial = history.range();
      history.navigate(-1); await history.whenSettled();
      expect(history.range()).toEqual({ start: initial.start - width, end: initial.end - width });
      expect(history.live()).toBe(false);
      history.navigate(1); await history.whenSettled(); expect(history.range()).toEqual(initial);
    }
    const earliest = retentionStart(Date.now()); history.selectRange(earliest, earliest + 3600000);
    history.navigate(-1); await history.whenSettled(); expect(history.range().start).toBe(earliest);
    history.now(); await history.whenSettled(); expect(history.live()).toBe(true); expect(history.range().end).toBe(Date.now());
  });

  it('rejects invalid, future and expired ranges without changing the displayed interval', async () => {
    const history = openHistory(); await history.whenSettled(); const original = history.range();
    const now = Date.now();
    for (const [start, end] of [[NaN, now], [now, now], [now, now - 1], [now - 1, now + 1], [retentionStart(now) - 1, now]]) {
      expect(history.selectRange(start, end)).toBe(false); expect(history.validation()).not.toBeNull();
      expect(history.range()).toEqual(original);
    }
  });

  it('loads exact original readings in pages, including duplicate timestamps', async () => {
    const now = Date.now();
    for (let i = 0; i < 123; i++) store.rows.push({ time: now - 1000, ppm: 600 + i, segment: 'one' });
    const history = openHistory(); await history.whenSettled();
    expect(history.rows()).toHaveLength(10); expect(history.rows()[0].ppm).toBe(722);
    history.changePage(1); await history.whenSettled();
    expect(history.pageNumber()).toBe(2); expect(history.rows()[0].ppm).toBe(712); expect(history.live()).toBe(true);
    history.changePage(1); await history.whenSettled();
    expect(history.rows()).toHaveLength(10); expect(history.rows()[9].ppm).toBe(693); expect(history.hasNextPage()).toBe(true);
    history.changePage(-1); await history.whenSettled(); expect(history.rows()[0].ppm).toBe(712);
    history.changePageSize(50); await history.whenSettled();
    expect(history.pageNumber()).toBe(1); expect(history.rows()).toHaveLength(50);
    history.changePage(1); await history.whenSettled(); history.changePage(1); await history.whenSettled();
    expect(history.rows()).toHaveLength(23); expect(history.rows()[22].ppm).toBe(600); expect(history.hasNextPage()).toBe(false);
    expect(store.rows).toHaveLength(123);
  });

  it('prunes only entries strictly before two calendar years on startup and hourly', async () => {
    const now = Date.now(); const cutoff = retentionStart(now);
    store.rows.push({ time: cutoff - 1, ppm: 500, segment: 'old' }, { time: cutoff, ppm: 600, segment: 'boundary' }, { time: now, ppm: 700, segment: 'new' });
    const history = openHistory(); await history.whenSettled();
    expect(store.rows.map(row => row.ppm)).toEqual([600, 700]); expect(history.count()).toBe(2);
    history.selectRange(now - 3600000, now); await history.whenSettled();
    await vi.advanceTimersByTimeAsync(3600000); await history.whenSettled();
    expect(store.rows.map(row => row.ppm)).toEqual([700]); expect(history.count()).toBe(1);
    expect(store.storage.prune).toHaveBeenCalledTimes(2);
  });

  it('keeps writing while an older range is being read and ignores stale results', async () => {
    const history = openHistory(); await history.whenSettled();
    let release!: (value: { count: number; rangeCount: number; entries: [] }) => void;
    store.storage.load.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const now = Date.now(); history.selectRange(now - 86400000, now - 3600000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await history.record(950, now);
    expect(store.rows).toHaveLength(1); expect(history.count()).toBe(1);
    history.now();
    release({ count: 0, rangeCount: 100, entries: [] });
    await history.whenSettled();
    expect(history.live()).toBe(true); expect(history.rangeCount()).toBe(1); expect(history.count()).toBe(1);
  });

  it('keeps table rows and page stable while live graph and source continue updating', async () => {
    const now = Date.now();
    for (let i = 0; i < 30; i++) store.rows.push({ time: now - (30 - i) * 1000, ppm: 600 + i, segment: 'seed' });
    const history = openHistory(); await history.whenSettled();
    history.changePage(1); await history.whenSettled();
    const rows = history.rows(); const tableRange = history.tableRange(); const oldPoints = history.measurements();
    const source = TestBed.inject(CO2_SOURCE); source.start();
    await vi.advanceTimersByTimeAsync(10000); await history.whenSettled();
    expect(history.live()).toBe(true); expect(history.pageNumber()).toBe(2);
    expect(history.rows()).toBe(rows); expect(history.tableRange()).toBe(tableRange); expect(history.tableCount()).toBe(30);
    expect(history.measurements()).not.toBe(oldPoints); expect(history.range().end).toBe(Date.now());
    expect(history.newMeasurements()).toBe(true);
    history.changePage(1); await history.whenSettled();
    expect(history.rows()[0].ppm).toBe(609); expect(history.rows()).toHaveLength(10); expect(history.hasNextPage()).toBe(false);
    await history.updateTable();
    expect(history.pageNumber()).toBe(1); expect(history.tableCount()).toBe(40);
    expect(history.rows()[0].ppm).toBe(source.current()!.ppm); expect(history.newMeasurements()).toBe(false);
  });

  it('resets the table to page one on every page size or period change and preserves filters', async () => {
    const now = Date.now(); const start = now - 3600000;
    for (let i = 0; i < 70; i++) store.rows.push({ time: start + i * 1000, ppm: 700 + i, segment: 'past' });
    store.rows.push({ time: now, ppm: 2000, segment: 'outside' });
    const history = openHistory(); await history.whenSettled();
    history.selectRange(start, start + 100000); await history.whenSettled();
    for (const size of [25, 50, 10]) {
      history.changePage(1); await history.whenSettled(); expect(history.pageNumber()).toBe(2);
      history.changePageSize(size); await history.whenSettled();
      expect(history.pageNumber()).toBe(1); expect(history.rows()).toHaveLength(size);
      expect(history.rows()[0].ppm).toBe(769); expect(history.tableCount()).toBe(70);
      expect(store.storage.page).toHaveBeenLastCalledWith(start, start + 100000, null, size, 'prev', 71);
    }
    history.changePage(1); await history.whenSettled(); history.choosePeriod('5m'); await history.whenSettled();
    expect(history.pageNumber()).toBe(1); expect(history.rows().map(row => row.ppm)).toEqual([2000]);
  });

  it('excludes later backdated inserts even with the same timestamp when paging a snapshot', async () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) store.rows.push({ time: now - 1000, ppm: 600 + i, segment: 'original' });
    const history = openHistory(); await history.whenSettled();
    history.changePage(1); await history.whenSettled(); await history.record(999, now - 1000); await history.whenSettled();
    expect(history.rows().map(row => row.ppm)).toEqual([609, 608, 607, 606, 605, 604, 603, 602, 601, 600]);
    expect(history.tableCount()).toBe(20); expect(history.newMeasurements()).toBe(true);
    await history.updateTable(); expect(history.rows()[0].ppm).toBe(999); expect(history.tableCount()).toBe(21);
  });

  it('drains an in-flight write after stop and never creates readings from the last value on timers', async () => {
    const history = openHistory(); const source = TestBed.inject(CO2_SOURCE);
    await history.whenSettled();
    let finish!: () => void;
    store.storage.append.mockImplementationOnce(point => new Promise(resolve => {
      finish = () => { store.rows.push(point); resolve(store.rows.length); };
    }));
    source.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(store.storage.append).toHaveBeenCalledTimes(1); expect(history.count()).toBe(0);
    source.stop(); const paused = source.current(); finish(); await history.whenSettled();
    expect(history.count()).toBe(1); expect(history.newMeasurements()).toBe(false);
    await history.updateTable(); const rows = history.rows();
    expect(history.newMeasurements()).toBe(false);
    await vi.advanceTimersByTimeAsync(60000); await history.whenSettled();
    expect(source.current()).toBe(paused); expect(store.storage.append).toHaveBeenCalledTimes(1);
    expect(history.count()).toBe(1); expect(history.rows()).toBe(rows); expect(history.pageNumber()).toBe(1);
    expect(history.newMeasurements()).toBe(false);
    history.choosePeriod('1h'); await history.whenSettled(); expect(history.rows()).toHaveLength(1);
  });

  it('does not flag a concurrent commit already included in the table snapshot', async () => {
    const history = openHistory(); await history.whenSettled();
    const time = Date.now() - 1000;
    const original = store.storage.tableSnapshot.getMockImplementation()!;
    let finish!: () => void;
    store.storage.tableSnapshot.mockImplementationOnce((start, end) => new Promise(resolve => {
      finish = () => { void original(start, end).then(resolve); };
    }));
    const update = history.updateTable();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await history.record(850, time); finish(); await update;
    expect(history.rows()[0].ppm).toBe(850); expect(history.tableCount()).toBe(1);
    expect(history.newMeasurements()).toBe(false);
  });

  it('does not flag writes outside a past filter while the table query is in flight', async () => {
    const history = openHistory(); await history.whenSettled(); const now = Date.now();
    history.selectRange(now - 7200000, now - 3600000); await history.whenSettled();
    const original = store.storage.tableSnapshot.getMockImplementation()!;
    let finish!: () => void;
    store.storage.tableSnapshot.mockImplementationOnce((start, end) => new Promise(resolve => {
      finish = () => { void original(start, end).then(resolve); };
    }));
    const update = history.updateTable(); for (let i = 0; i < 5; i++) await Promise.resolve();
    await history.record(900, now); finish(); await update;
    expect(history.count()).toBe(1); expect(history.rows()).toHaveLength(0); expect(history.newMeasurements()).toBe(false);
  });

  it('keeps paused graph identity and avoids timer queries and loading flashes', async () => {
    const history = openHistory(); const source = TestBed.inject(CO2_SOURCE);
    await history.whenSettled(); source.start(); await vi.advanceTimersByTimeAsync(5000); await history.whenSettled();
    source.stop(); await history.refresh();
    const points = history.measurements(); const range = history.range(); const calls = store.storage.load.mock.calls.length;
    const rows = history.rows();
    await vi.advanceTimersByTimeAsync(60000); await history.whenSettled();
    expect(store.storage.load).toHaveBeenCalledTimes(calls); expect(history.measurements()).toBe(points);
    expect(history.range()).toBe(range); expect(history.rows()).toBe(rows); expect(history.loading()).toBe(false);
    const query = history.refresh(true); expect(history.loading()).toBe(false); await query;
    expect(history.measurements()).toBe(points);
  });

  it('automatically prepends live page one without changing its size or showing loading', async () => {
    const history = openHistory(); const source = TestBed.inject(CO2_SOURCE);
    await history.whenSettled(); history.changePageSize(25); await history.whenSettled(); source.start();
    await vi.advanceTimersByTimeAsync(5000); await history.whenSettled();
    expect(history.pageSize()).toBe(25); expect(history.pageNumber()).toBe(1); expect(history.rows()).toHaveLength(5);
    expect(history.rows()[0].ppm).toBe(source.current()!.ppm); expect(history.newMeasurements()).toBe(false);
    expect(history.tableLoading()).toBe(false); expect(history.loading()).toBe(false);
  });

  it('keeps a past table stable and offers refresh only for commits inside its interval', async () => {
    const now = Date.now(); const start = now - 7200000;
    store.rows.push({ time: start + 1000, ppm: 700, segment: 'past' });
    const history = openHistory(); await history.whenSettled();
    history.selectRange(start, start + 3600000); await history.whenSettled(); const rows = history.rows();
    await history.record(900, now); await history.whenSettled();
    expect(history.rows()).toBe(rows); expect(history.newMeasurements()).toBe(false);
    await history.record(800, start + 2000); await history.whenSettled();
    expect(history.rows()).toBe(rows); expect(history.newMeasurements()).toBe(true);
    await history.updateTable(); expect(history.rows()[0].ppm).toBe(800); expect(history.newMeasurements()).toBe(false);
  });

  it('persists while hidden without view queries, including the hourly retention task', async () => {
    const history = TestBed.inject(Co2History); const source = TestBed.inject(CO2_SOURCE);
    await history.whenSettled(); expect(history.visible()).toBe(false);
    source.start(); await vi.advanceTimersByTimeAsync(10000); await history.whenSettled(); source.stop();
    expect(history.count()).toBe(10);
    await vi.advanceTimersByTimeAsync(3600000); await history.whenSettled();
    expect(store.storage.load).not.toHaveBeenCalled(); expect(store.storage.page).not.toHaveBeenCalled();
    expect(store.storage.tableSnapshot).not.toHaveBeenCalled(); expect(store.storage.prune).toHaveBeenCalledTimes(2);
    history.setVisible(true); await history.whenSettled();
    expect(history.count()).toBe(10); expect(history.measurements()).toHaveLength(0);
    expect(store.storage.load).toHaveBeenCalledTimes(1);
  });

  it('keeps a past range and page while hidden and refreshes that page on reopening', async () => {
    const now = Date.now(); const start = now - 7200000;
    for (let i = 0; i < 30; i++) store.rows.push({ time: start + i * 1000, ppm: 600 + i, segment: 'past' });
    const history = openHistory(); await history.whenSettled();
    history.selectRange(start, start + 3600000); await history.whenSettled();
    history.changePage(1); await history.whenSettled();
    const rows = history.rows(); const points = history.measurements(); const range = history.range();
    const calls = store.storage.load.mock.calls.length; history.setVisible(false);
    await history.record(1000, now); await vi.advanceTimersByTimeAsync(10000); await history.whenSettled();
    expect(history.rows()).toBe(rows); expect(history.measurements()).toBe(points);
    expect(history.range()).toBe(range); expect(history.pageNumber()).toBe(2);
    expect(store.storage.load).toHaveBeenCalledTimes(calls);
    history.setVisible(true); await history.whenSettled();
    expect(history.period()).toBe('custom'); expect(history.range()).toBe(range);
    expect(history.pageNumber()).toBe(2); expect(history.rows()).toEqual(rows);
    expect(store.storage.page).toHaveBeenLastCalledWith(start, start + 3600000, expect.any(Object), 10, 'prev', 30);
  });
});
