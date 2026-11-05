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
  it('shows browser filters immediately and loads the selected period with Verlauf anzeigen', async () => {
    const fixture = TestBed.createComponent(ServerHistoryBlock); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLElement>('#server-history')!.hidden).toBe(false);
    expect(el.querySelector('[aria-controls="server-history"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    const inputs = el.querySelectorAll<HTMLInputElement>('input');
    for (const [index, value] of ['2026-02-01T12:00', '2026-02-02T12:00'].entries()) {
      inputs[index].value = value; inputs[index].dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
    const button = el.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('Verlauf anzeigen'); button.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const url = new URL(request.mock.calls[0][0] as string, 'http://localhost');
    expect(url.searchParams.get('from')).toBe(new Date(inputs[0].value).toISOString());
    expect(url.searchParams.get('to')).toBe(new Date(inputs[1].value).toISOString());
    await vi.waitFor(() => expect(fixture.debugElement.injector.get(ServerHistory).loading()).toBe(false));
    fixture.detectChanges(); expect(el.querySelector('tbody tr')).not.toBeNull(); fixture.destroy();
  });
  it('sorts through the API, discards old cursors and updates accessible headers', async () => {
    const fixture = TestBed.createComponent(ServerHistoryBlock); fixture.detectChanges();
    const service = fixture.debugElement.injector.get(ServerHistory);
    request.mockResolvedValueOnce(page([row()], 'old-cursor'));
    await service.load(); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('caption')).toBeNull();
    const buttons = el.querySelectorAll<HTMLButtonElement>('th button');
    expect(el.querySelector('th')!.getAttribute('aria-sort')).toBe('descending');
    for (const [index, sort] of [[0, 'time-asc'], [0, 'time-desc'], [1, 'ppm-desc'], [1, 'ppm-asc']] as const) {
      el.querySelectorAll<HTMLButtonElement>('th button')[index].click(); fixture.detectChanges();
      expect(service.nextCursor()).toBeNull();
      await vi.waitFor(() => expect(service.loading()).toBe(false)); fixture.detectChanges();
      const url = new URL(request.mock.calls.at(-1)![0] as string, 'http://localhost');
      expect(url.searchParams.get('sort')).toBe(sort); expect(url.searchParams.has('cursor')).toBe(false);
      const button = el.querySelectorAll<HTMLButtonElement>('th button')[index];
      expect(button.parentElement!.getAttribute('aria-sort')).toBe(sort.endsWith('asc') ? 'ascending' : 'descending');
      expect(button.textContent).toContain(sort.endsWith('asc') ? '\u2191' : '\u2193');
    }
    expect(el.querySelector('th')!.getAttribute('aria-sort')).toBe('none');
    fixture.destroy();
  });
  it('uses the same sorting controls with native HTTP on Android', async () => {
    TestBed.resetTestingModule();
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const get = vi.spyOn(ServerHistory.prototype, 'getNative').mockResolvedValue({ status: 200, data: { items: [row()], nextCursor: null }, headers: {}, url: '' });
    TestBed.configureTestingModule({ providers: [{ provide: MEASUREMENT_API_CONFIG, useValue: { browserBaseUrl: '/api', nativeBaseUrl: 'http://127.0.0.1:5045/api', usbDebug: true } }] });
    const fixture = TestBed.createComponent(ServerHistoryBlock); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector<HTMLElement>('#server-history')!.hidden).toBe(false);
    const button = el.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('Verlauf anzeigen'); button.click();
    const service = fixture.debugElement.injector.get(ServerHistory);
    await vi.waitFor(() => expect(service.loading()).toBe(false)); fixture.detectChanges();
    expect(el.querySelector('caption')).toBeNull();
    expect(el.querySelectorAll('th')).toHaveLength(2); expect(el.querySelectorAll('tbody td')).toHaveLength(2);
    el.querySelector<HTMLButtonElement>('th button')!.click();
    await vi.waitFor(() => expect(service.loading()).toBe(false)); fixture.detectChanges();
    expect(new URL(get.mock.calls.at(-1)![0].url).searchParams.get('sort')).toBe('time-asc');
    expect(el.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
    expect(request).not.toHaveBeenCalled(); fixture.destroy();
  });
  it('shows German empty/error states and clears the table immediately when inputs change', async () => {
    const fixture = TestBed.createComponent(ServerHistoryBlock); fixture.detectChanges();
    const service = fixture.debugElement.injector.get(ServerHistory);
    request.mockResolvedValueOnce(page([])); await service.load(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Keine Messungen');
    request.mockResolvedValueOnce(page()); await service.load(); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('tbody tr')).not.toBeNull();
    const headers = Array.from(fixture.nativeElement.querySelectorAll('th') as NodeListOf<HTMLElement>, cell => cell.textContent);
    expect(headers.map(x => x?.trim())).toEqual(['Zeit ↓', 'CO₂ (ppm)']);
    expect(fixture.nativeElement.querySelectorAll('tbody tr:first-child td')).toHaveLength(2);
    expect(service.rows()[0].source).toBe('sensor');
    expect(fixture.nativeElement.textContent).not.toContain('Quelle');
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
