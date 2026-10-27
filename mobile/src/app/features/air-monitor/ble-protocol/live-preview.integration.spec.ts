import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Capacitor } from '@capacitor/core';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { routes } from '../../../app.routes';
import { AirMonitorPage } from '../air-monitor-page';
import { DeviceDiscovery } from '../components/device-discovery/device-discovery';
import { BLE_ADAPTER, BleAdapter } from '../data-access/ble-adapter';
import { BleConnection } from '../data-access/ble-connection';
import { BLE_SESSION, LiveSample } from '../data-access/ble-session';
import { BleScanner } from '../data-access/ble-scanner';
import { BleJournalSync } from '../data-access/ble-journal-sync';
import { Co2Monitor } from '../data-access/co2-monitor';
import { Co2Simulator } from '../data-access/co2-simulator';
import { CO2_SOURCE } from '../data-access/co2-source';
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
    expect(fixture.debugElement.injector.get(BLE_SESSION)).toBe(connection);
    expect(child.get(BLE_SESSION)).toBe(connection);
    expect(TestBed.inject(BLE_SESSION)).toBe(connection);
    expect(child.get(BleScanner)).toBe(TestBed.inject(BleScanner));
    expect(child.get(BleJournalSync)).toBe(TestBed.inject(BleJournalSync));
    expect(child.get(Co2Monitor)).toBe(TestBed.inject(Co2Monitor));
    expect((TestBed.inject(Co2Monitor) as unknown as { connection: BleConnection }).connection).toBe(connection);
    expect((child.get(BleJournalSync) as unknown as { connection: BleConnection }).connection).toBe(connection);
    fixture.destroy();
  });

  it('shows only fresh Sensor data, preserves existing history and never persists or uploads preview', async () => {
    await history.whenSettled();
    await storage.append({ time: Date.now() - 1000, ppm: 650, segment: 'existing-history' });
    await history.imported();
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const reading = () => el.querySelector('.measurement strong')!.textContent;
    const source = TestBed.inject(CO2_SOURCE);
    expect(TestBed.inject(Co2Simulator, null)).toBeNull();
    expect(source.state().status).toBe('stopped'); expect(source.current()).toBeNull();
    expect(reading()).toBe('—');
    expect(await storage.count()).toBe(1);
    const append = vi.spyOn(storage, 'append');
    await connection.connect('sensor'); fixture.detectChanges();
    expect(reading()).toBe('—'); expect(el.textContent).toContain('Warte auf einen neuen Sensorwert');
    expect(adapter.subscribe).toHaveBeenCalledOnce();
    expect(el.querySelector('.source-picker, .simulation-toggle, .prototype-warning')).toBeNull();
    expect(el.textContent).toContain('Sensor verbinden');
    emit(sample(1n)); fixture.detectChanges(); expect(reading()).toBe('950');
    expect(el.querySelector('.status')?.textContent).toContain('CO₂-Wert akzeptabel');
    emit(sample(1n, 2222)); fixture.detectChanges(); expect(reading()).toBe('950'); // Duplicate ignored.
    emit(sample(2n, 1000)); fixture.detectChanges(); expect(reading()).toBe('1000');
    expect(el.querySelector('.status')?.textContent).toContain('Bitte lüften');
    emit(sample(3n, 2000)); fixture.detectChanges(); expect(reading()).toBe('2000');
    expect(el.querySelector('.status')?.textContent).toContain('Hoher CO₂-Wert');
    expect(el.querySelector('.hint')?.textContent).toContain('Bitte lüften');
    await vi.advanceTimersByTimeAsync(2000); await history.whenSettled(); await history.refresh();
    expect(append).not.toHaveBeenCalled(); expect(await storage.count()).toBe(1); expect(history.measurements()).toHaveLength(1);
    expect(request).not.toHaveBeenCalled(); await TestBed.inject(Co2Sync).synchronize();
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
    expect(body.source).toBe('simulator'); expect(body.measurements).toHaveLength(1);
    emit(sample(4n)); await TestBed.inject(Co2Sync).synchronize(); expect(request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10000); await history.whenSettled();
    expect(await storage.count()).toBe(1); expect(source.state().status).toBe('stopped');
    expect(append).not.toHaveBeenCalled(); fixture.destroy();
  });

  it('clears on disconnect, waits for NEW data and ignores obsolete callbacks on reconnect', async () => {
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    await connection.connect('sensor'); emit(sample(50n)); fixture.detectChanges();
    expect(el.querySelector('.measurement')?.textContent).toContain('950');
    const oldReceive = receive; const oldLost = lost; lost(); fixture.detectChanges();
    expect(el.querySelector('.measurement strong')?.textContent).toBe('—'); expect(el.textContent).toContain('Sensor nicht verfügbar');
    await connection.disconnect(); await connection.connect('sensor');
    fixture.detectChanges(); expect(el.querySelector('.measurement strong')?.textContent).toBe('—');
    fragmentMessage(sample(99n, 2222), 1, 'events').forEach(frame => oldReceive(view(frame))); oldLost();
    emit(sample(1n, 800)); fixture.detectChanges();
    expect(connection.state()).toBe('ready'); expect(el.querySelector('.measurement strong')?.textContent).toBe('800');
    expect(await storage.count()).toBe(0); fixture.destroy();
  });
});
