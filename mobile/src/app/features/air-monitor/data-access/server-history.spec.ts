import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { ServerHistory } from './server-history';
import { MEASUREMENT_API_CONFIG } from './measurement-api.config';
import { ServerHistoryBlock } from '../components/server-history/server-history';

const filters = { from: '2026-02-01T01:00:00+01:00', to: '2026-02-02T01:00:00+01:00', deviceId: '' };
const id = '00112233-4455-4677-8899-aabbccddeeff';
const row = (measurementId = id) => ({ measurementId, deviceId: id, source: 'sensor', measuredAt: '2026-02-01T12:00:00Z', receivedAt: '2026-02-01T13:00:00Z', ppm: 900, segment: 'one' });
const page = (items = [row()], nextCursor: string | null = null) => new Response(JSON.stringify({ items, nextCursor }));
describe('server history HTTP and volatile pages', () => {
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let history: ServerHistory;
  beforeEach(() => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false); vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    request = vi.fn(async () => page()); vi.stubGlobal('fetch', request);
    TestBed.configureTestingModule({ providers: [ServerHistory, { provide: MEASUREMENT_API_CONFIG, useValue: { browserBaseUrl: '/api/', nativeBaseUrl: null } }] });
    history = TestBed.inject(ServerHistory); history.setFilters(filters);
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('sends UTC half-open bounds, optional device ID and default page size without storage', async () => {
    const open = vi.fn(); vi.stubGlobal('indexedDB', { open });
    history.setFilters({ ...filters, deviceId: id }); await history.load();
    const url = new URL(request.mock.calls[0][0] as string, 'http://localhost');
    expect(url.pathname).toBe('/api/measurements');
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: '2026-02-01T00:00:00.000Z', to: '2026-02-02T00:00:00.000Z', pageSize: '50', deviceId: id });
    expect(history.rows()).toEqual([row()]); expect(open).not.toHaveBeenCalled();
  });
  it('appends only on explicit nextCursor pagination and resets on filter changes', async () => {
    request.mockResolvedValueOnce(page([row()], 'opaque+/cursor')).mockResolvedValueOnce(page([row('second')]));
    await history.load(); expect(request).toHaveBeenCalledOnce();
    expect(new URL(request.mock.calls[0][0] as string, 'http://localhost').searchParams.has('deviceId')).toBe(false);
    await history.load(true);
    expect(new URL(request.mock.calls[1][0] as string, 'http://localhost').searchParams.get('cursor')).toBe('opaque+/cursor');
    expect(history.rows()).toHaveLength(2); expect(history.nextCursor()).toBeNull();
    history.setFilters({ ...filters, deviceId: id }); expect(history.rows()).toEqual([]); expect(history.loaded()).toBe(false);
    await history.load(); expect(new URL(request.mock.calls[2][0] as string, 'http://localhost').searchParams.has('cursor')).toBe(false);
  });
  it('ignores old replies even if abort is ignored and does not clear the new loading state', async () => {
    let resolve!: (value: Response) => void;
    let resolveNew!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(done => resolve = done));
    request.mockImplementationOnce(() => new Promise<Response>(done => resolveNew = done));
    const old = history.load(); history.setFilters({ ...filters, deviceId: id }); const fresh = history.load();
    resolve(page([row('obsolete')], 'obsolete')); await old;
    expect(history.rows()).toEqual([]); expect(history.loading()).toBe(true);
    resolveNew(page()); await fresh;
    expect(history.rows()).toEqual([row()]); expect(history.nextCursor()).toBeNull(); expect(history.loading()).toBe(false);
  });
  it('handles empty results, rejected filters, HTTP failures and invalid responses', async () => {
    request.mockResolvedValueOnce(page([])); await history.load(); expect(history.loaded()).toBe(true); expect(history.rows()).toEqual([]);
    history.setFilters({ ...filters, to: filters.from }); await history.load(); expect(history.error()).toContain('Zeitraum'); expect(request).toHaveBeenCalledOnce();
    history.setFilters(filters); request.mockResolvedValueOnce(new Response('', { status: 400 })); await history.load(); expect(history.error()).toContain('abgelehnt');
    request.mockRejectedValueOnce(new TypeError('offline')); await history.load(); expect(history.error()).toContain('nicht erreichbar');
    request.mockResolvedValueOnce(new Response('{}')); await history.load(); expect(history.error()).toContain('ungültige Antwort');
  });
  it('keeps previous rows and cursor after a failed next page so it can be retried', async () => {
    request.mockResolvedValueOnce(page([row()], 'next')); await history.load();
    request.mockResolvedValueOnce(new Response('', { status: 503 })); await history.load(true);
    expect(history.rows()).toEqual([row()]); expect(history.nextCursor()).toBe('next'); expect(history.error()).toContain('nicht geladen');
  });
  it('uses the existing Android USB API configuration and native HTTP transport', async () => {
    TestBed.resetTestingModule(); vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true); vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    const get = vi.spyOn(ServerHistory.prototype, 'getNative').mockResolvedValue({ status: 200, data: { items: [], nextCursor: null }, headers: {}, url: '' });
    TestBed.configureTestingModule({ providers: [ServerHistory, { provide: MEASUREMENT_API_CONFIG, useValue: { browserBaseUrl: '/api', nativeBaseUrl: 'http://127.0.0.1:5045/api', usbDebug: true } }] });
    history = TestBed.inject(ServerHistory); history.setFilters(filters); await history.load();
    expect(get.mock.calls[0][0].url).toContain('http://127.0.0.1:5045/api/measurements?'); expect(request).not.toHaveBeenCalled();
  });
  it('shows German empty/error states and clears the table immediately when inputs change', async () => {
    const fixture = TestBed.createComponent(ServerHistoryBlock); fixture.detectChanges();
    const service = fixture.debugElement.injector.get(ServerHistory);
    request.mockResolvedValueOnce(page([])); await service.load(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Keine Messungen');
    request.mockResolvedValueOnce(page()); await service.load(); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('tbody tr')).not.toBeNull();
    const headers = Array.from(fixture.nativeElement.querySelectorAll('th') as NodeListOf<HTMLElement>, cell => cell.textContent);
    expect(headers).toEqual(['Zeit', 'CO₂ (ppm)', 'Quelle']);
    expect(fixture.nativeElement.querySelectorAll('tbody tr:first-child td')).toHaveLength(3);
    expect(fixture.nativeElement.querySelectorAll('input')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('input[type="text"]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Geräte-ID');
    expect(fixture.nativeElement.textContent).not.toContain('Segment');
    expect(new URL(request.mock.calls.at(-1)![0] as string, 'http://localhost').searchParams.has('deviceId')).toBe(false);
    request.mockResolvedValueOnce(new Response('', { status: 503 })); await service.load(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('nicht geladen');
    const input = fixture.nativeElement.querySelector('input'); input.value = '2026-02-01T12:00'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    expect(service.rows()).toEqual([]); expect(fixture.nativeElement.querySelector('table')).toBeNull(); fixture.destroy();
  });
  it('ignores a late reply after scope destruction', async () => {
    let resolve!: (value: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(done => resolve = done));
    const pending = history.load(); TestBed.resetTestingModule(); resolve(page()); await pending;
    expect(history.rows()).toEqual([]); expect(history.loaded()).toBe(false);
  });
});
