import { TestBed } from '@angular/core/testing';
import { ServerHistory, HistorySort } from './server-history';
import { ANDROID_BLE } from './ble-platform';
import { NATIVE_HISTORY_BRIDGE, NativeHistoryBridge } from './native-history-bridge';
import { ServerHistoryBlock } from '../components/server-history/server-history';

const filters = { from: '2026-02-01T01:00:00+01:00', to: '2026-02-02T01:00:00+01:00', deviceId: '' };
const id = '00112233-4455-4677-8899-aabbccddeeff';
const row = (measurementId = id) => ({
  measurementId,
  deviceId: id,
  bootId: id,
  source: 'sensor',
  ppm: 900,
  measuredAtMs: String(Date.parse('2026-02-01T12:00:00.123Z')),
});
const page = (items = [row()], nextCursor: string | null = null) => ({ items, nextCursor });

describe('Android native receipt history', () => {
  let bridge: { getLiveHistory: ReturnType<typeof vi.fn<NativeHistoryBridge['getLiveHistory']>> };
  let history: ServerHistory;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridge = { getLiveHistory: vi.fn(async () => page()) };
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    TestBed.configureTestingModule({
      providers: [
        ServerHistory,
        { provide: ANDROID_BLE, useValue: true },
        { provide: NATIVE_HISTORY_BRIDGE, useValue: bridge },
      ],
    });
    history = TestBed.inject(ServerHistory);
    history.setFilters(filters);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses only the existing bridge, passing exact receipt bounds without HTTP or IndexedDB', async () => {
    const http = vi.spyOn(history, 'getNative');
    const open = vi.fn();
    vi.stubGlobal('indexedDB', { open });
    await history.load();
    expect(bridge.getLiveHistory).toHaveBeenCalledExactlyOnceWith({
      fromMs: String(Date.parse(filters.from)),
      toMs: String(Date.parse(filters.to)),
      sort: 'time-desc',
      pageSize: 50,
    });
    expect(history.rows()[0].measuredAt).toBe('2026-02-01T12:00:00.123Z');
    expect(history.rows()[0].receivedAt).toBe(history.rows()[0].measuredAt);
    expect(http).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('appends native pages, preserves retry state after a disk error and resets on sort/filter changes', async () => {
    bridge.getLiveHistory.mockResolvedValueOnce(page([row()], 'old-cursor'));
    await history.load();
    bridge.getLiveHistory.mockRejectedValueOnce(new Error('SQLite disk I/O error'));
    await history.load(true);
    expect(history.rows()).toHaveLength(1);
    expect(history.nextCursor()).toBe('old-cursor');
    expect(history.error()).toContain('SQLite disk I/O error');
    bridge.getLiveHistory.mockResolvedValueOnce(page([row('second')]));
    await history.load(true);
    expect(history.rows()).toHaveLength(2);
    expect(bridge.getLiveHistory.mock.calls.at(-1)![0].cursor).toBe('old-cursor');
    for (const sort of ['time-asc', 'time-desc', 'ppm-desc', 'ppm-asc'] as HistorySort[]) {
      history.setFilters({ ...filters, sort });
      expect(history.rows()).toEqual([]);
      await history.load();
      expect(bridge.getLiveHistory.mock.calls.at(-1)![0]).toMatchObject({ sort });
      expect(bridge.getLiveHistory.mock.calls.at(-1)![0].cursor).toBeUndefined();
    }
  });

  it('ignores an obsolete native page after filters change', async () => {
    let done!: (value: unknown) => void;
    bridge.getLiveHistory.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = history.load();
    history.setFilters({ ...filters, sort: 'ppm-asc' });
    await history.load();
    done(page([row('obsolete')], 'obsolete'));
    await pending;
    expect(history.rows()[0].measurementId).toBe(id);
    expect(history.nextCursor()).toBeNull();
  });

  it('shows empty history and actual storage failures, rejecting invalid local responses', async () => {
    bridge.getLiveHistory.mockResolvedValueOnce(page([]));
    await history.load();
    expect(history.loaded()).toBe(true);
    expect(history.rows()).toEqual([]);
    bridge.getLiveHistory.mockRejectedValueOnce(new Error('no such table: live_samples'));
    await history.load();
    expect(history.loaded()).toBe(false);
    expect(history.error()).toContain('no such table');
    bridge.getLiveHistory.mockResolvedValueOnce(page([{ ...row(), measuredAtMs: '18446744073709551615' }]));
    await history.load();
    expect(history.error()).toContain('lokale Verlauf');
    history.setFilters({ ...filters, to: filters.from });
    const calls = bridge.getLiveHistory.mock.calls.length;
    await history.load();
    expect(history.error()).toContain('Zeitraum');
    expect(bridge.getLiveHistory).toHaveBeenCalledTimes(calls);
  });

  it('keeps the common UI, all sort directions and Weitere laden with local data', async () => {
    const fixture = TestBed.createComponent(ServerHistoryBlock);
    fixture.detectChanges();
    const service = fixture.debugElement.injector.get(ServerHistory);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('input[type="datetime-local"]')).toHaveLength(2);
    bridge.getLiveHistory.mockResolvedValueOnce(page([row()], 'next'));
    el.querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(service.loading()).toBe(false));
    fixture.detectChanges();
    expect(el.querySelectorAll('th')).toHaveLength(2);
    expect(el.querySelectorAll('tbody td')).toHaveLength(2);
    const more = Array.from(el.querySelectorAll('button')).find(button => button.textContent === 'Weitere laden')!;
    bridge.getLiveHistory.mockResolvedValueOnce(page([row('second')]));
    more.click();
    await vi.waitFor(() => expect(service.loading()).toBe(false));
    fixture.detectChanges();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    for (const [index, sort] of [[0, 'time-asc'], [0, 'time-desc'], [1, 'ppm-desc'], [1, 'ppm-asc']] as const) {
      el.querySelectorAll<HTMLButtonElement>('th button')[index].click();
      await vi.waitFor(() => expect(bridge.getLiveHistory.mock.calls.at(-1)![0].sort).toBe(sort));
      await vi.waitFor(() => expect(service.loading()).toBe(false));
      fixture.detectChanges();
      expect(el.querySelectorAll('th')[index].getAttribute('aria-sort')).toBe(sort.endsWith('asc') ? 'ascending' : 'descending');
      expect(bridge.getLiveHistory.mock.calls.at(-1)![0].cursor).toBeUndefined();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
