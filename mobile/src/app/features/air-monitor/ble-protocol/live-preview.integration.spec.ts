import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Capacitor } from '@capacitor/core';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { routes } from '../../../app.routes';
import { AirMonitorPage } from '../air-monitor-page';
import { DeviceDiscovery } from '../components/device-discovery/device-discovery';
import { BLE_ADAPTER, BleAdapter } from '../data-access/ble-adapter';
import { BleConnection, LiveSample } from '../data-access/ble-connection';
import { BleScanner } from '../data-access/ble-scanner';
import { BleJournalSync } from '../data-access/ble-journal-sync';
import { Co2Monitor } from '../data-access/co2-monitor';
import { Co2Simulator } from '../data-access/co2-simulator';
import { Co2History } from '../data-access/co2-history';
import { Co2Storage } from '../data-access/co2-storage';
import { Co2Sync } from '../data-access/co2-sync';
import { encodeInfo, Message } from './codec';
import { fragmentMessage } from './fragments';

const uuid = '00112233-4455-4677-8899-aabbccddeeff';
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('Shared BLE session and volatile Sensor UI', () => {
  let connection: BleConnection;
  let storage: Co2Storage;
  let history: Co2History;
  let receive: (value: DataView) => void;
  let lost: () => void;
  let eventId: number;
  let adapter: BleAdapter;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  const emit = (message: Message) => fragmentMessage(message, eventId++, 'events').forEach(frame => receive(view(frame)));
  const sample = (counter: bigint, ppm = 950): LiveSample => ({ type: 0x8a, bootId: uuid, sampleCounter: counter, uptimeMs: counter * 5000n, ppm });
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    request = vi.fn(async (_, init) => {
      const received = JSON.parse(init!.body as string).measurements.length;
      return new Response(JSON.stringify({ received, inserted: received, duplicates: 0 }), { status: 200 });
    });
    vi.stubGlobal('fetch', request);
    adapter = {
      available: () => true, initialize: vi.fn(async () => {}),
      connect: vi.fn(async (_, callback) => { eventId = 0; lost = callback; }),
      readInfo: vi.fn(async () => view(encodeInfo(uuid, 16, 1))),
      subscribe: vi.fn(async (_, callback) => { receive = callback; }),
      unsubscribe: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
      write: vi.fn(async (_, value) => emit({ type: 0x80, requestId: value.getUint16(2, true), bootId: uuid,
        oldest: 0n, latest: 0n, overwrittenThrough: 0n, timeValid: 0, firstUndated: 0n, storageState: 0 })),
    };
    TestBed.configureTestingModule({ imports: [AirMonitorPage], providers: [...routes[0].providers!, Co2Sync,
      { provide: BLE_ADAPTER, useValue: adapter }] });
    connection = TestBed.inject(BleConnection); storage = TestBed.inject(Co2Storage); history = TestBed.inject(Co2History);
  });
  afterEach(async () => {
    await connection.disconnect(); await history.whenSettled(); TestBed.resetTestingModule(); await storage.close();
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('shares the route session with the page, discovery and manual journal coordinator', () => {
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const child = fixture.debugElement.query(By.directive(DeviceDiscovery)).injector;
    expect(fixture.debugElement.injector.get(BleConnection)).toBe(connection);
    expect(child.get(BleConnection)).toBe(connection);
    expect(child.get(BleScanner)).toBe(TestBed.inject(BleScanner));
    expect(child.get(BleJournalSync)).toBe(TestBed.inject(BleJournalSync));
    expect(child.get(Co2Monitor)).toBe(TestBed.inject(Co2Monitor));
    expect((TestBed.inject(Co2Monitor) as unknown as { connection: BleConnection }).connection).toBe(connection);
    expect((child.get(BleJournalSync) as unknown as { connection: BleConnection }).connection).toBe(connection);
    fixture.destroy();
  });

  it('switches explicitly, shows a dash until NEW data, and never persists or uploads preview', async () => {
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const select = (value: string) => { el.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click(); fixture.detectChanges(); };
    const reading = () => el.querySelector('.measurement strong')!.textContent;
    const monitor = TestBed.inject(Co2Monitor); const simulator = TestBed.inject(Co2Simulator);
    await history.whenSettled(); monitor.toggleSimulation(); await vi.advanceTimersByTimeAsync(1000); await history.whenSettled();
    expect(await storage.count()).toBe(1);
    const append = vi.spyOn(storage, 'append');
    await connection.connect('sensor'); emit(sample(1n)); fixture.detectChanges();
    expect(monitor.selected()).toBe('simulator'); expect(simulator.state().status).toBe('running');
    expect(reading()).toBe(String(simulator.current().ppm)); expect(adapter.subscribe).toHaveBeenCalledOnce();
    select('sensor'); expect(reading()).toBe('—'); expect(simulator.state().status).toBe('stopped');
    expect(el.querySelector('.simulation-toggle')).toBeNull();
    expect(el.querySelector('.prototype-warning')?.textContent).toContain('Bei unserem SCD41');
    expect(el.textContent).toContain('Sensor verbinden');
    emit(sample(1n)); fixture.detectChanges(); expect(reading()).toBe('—'); // Not fresh.
    emit(sample(2n)); fixture.detectChanges(); expect(reading()).toBe('950');
    emit(sample(3n, 970)); fixture.detectChanges(); expect(reading()).toBe('970');
    await vi.advanceTimersByTimeAsync(2000); await history.whenSettled(); await history.refresh();
    expect(append).not.toHaveBeenCalled(); expect(await storage.count()).toBe(1); expect(history.measurements()).toHaveLength(1);
    expect(request).not.toHaveBeenCalled(); await TestBed.inject(Co2Sync).synchronize();
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
    expect(body.source).toBe('simulator'); expect(body.measurements).toHaveLength(1);
    emit(sample(4n)); await TestBed.inject(Co2Sync).synchronize(); expect(request).toHaveBeenCalledOnce();
    select('simulator'); expect(simulator.state().status).toBe('running'); expect(el.querySelector('.prototype-warning')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); await history.whenSettled(); expect(await storage.count()).toBe(2);
    select('sensor'); expect(reading()).toBe('—'); fixture.destroy();
  });

  it('clears on disconnect, retains Sensor selection, and ignores obsolete callbacks on reconnect', async () => {
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement; const monitor = TestBed.inject(Co2Monitor);
    monitor.select('sensor'); await connection.connect('sensor'); emit(sample(50n)); fixture.detectChanges();
    expect(el.querySelector('.measurement')?.textContent).toContain('950');
    const oldReceive = receive; const oldLost = lost; lost(); fixture.detectChanges();
    expect(el.querySelector('.measurement strong')?.textContent).toBe('—'); expect(el.textContent).toContain('Sensor nicht verfügbar');
    expect(monitor.selected()).toBe('sensor'); await connection.disconnect(); await connection.connect('sensor');
    fixture.detectChanges(); expect(el.querySelector('.measurement strong')?.textContent).toBe('—');
    fragmentMessage(sample(99n, 2222), 1, 'events').forEach(frame => oldReceive(view(frame))); oldLost();
    emit(sample(1n, 800)); fixture.detectChanges();
    expect(connection.state()).toBe('ready'); expect(el.querySelector('.measurement strong')?.textContent).toBe('800');
    expect(await storage.count()).toBe(0); fixture.destroy();
  });
});
