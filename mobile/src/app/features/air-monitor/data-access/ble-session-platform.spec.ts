import { TestBed } from '@angular/core/testing';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { routes } from '../../../app.routes';
import { BLE_SESSION, BleSession } from './ble-session';
import { NativeBleSession } from './native-ble-session';
import { BrowserBleSession } from './browser-ble-session';
import { BleConnection } from './ble-connection';
import { BLE_SERVICE_SESSION_BRIDGE } from './ble-service-session-bridge';
import { Co2Monitor } from './co2-monitor';
import { BleJournalSync } from './ble-journal-sync';
import { DeviceDiscovery } from '../components/device-discovery/device-discovery';
import { NativeBleBinding } from './native-ble-binding';
import { Co2History } from './co2-history';
import { Co2Storage } from './co2-storage';

describe('production BLE_SESSION selection', () => {
  const bridge = { getState: vi.fn(), getBinding: vi.fn(), migrateBinding: vi.fn(), start: vi.fn(), requestPermissions: vi.fn() };
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.resetAllMocks();
    bridge.getBinding.mockResolvedValue({ migrationComplete: true, revision: '1', binding: null });
    bridge.getState.mockResolvedValue({ state: 'stopped', runId: null, info: null, status: null, lastSample: null, sampleAvailable: false, nowElapsedMs: '0', reason: null, bindingError: null, permissionsGranted: true });
    TestBed.configureTestingModule({ providers: [...routes[0].providers!, { provide: BLE_SERVICE_SESSION_BRIDGE, useValue: bridge }] });
  });
  afterEach(async () => {
    // Route DI also initializes history. Drain its IDB work before removing the fake browser globals.
    const storage = TestBed.inject(Co2Storage); await TestBed.inject(Co2History).whenSettled();
    TestBed.resetTestingModule(); await storage.close(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it('selects one native facade for the page, discovery and journal on Android, with no legacy owner', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    const legacyConnect = vi.spyOn(BleClient, 'connect'); const session = TestBed.inject(BLE_SESSION);
    expect(session).toBe(TestBed.inject(NativeBleSession)); expect(TestBed.inject(BleConnection, null)).toBeNull();
    const monitor = TestBed.inject(Co2Monitor) as unknown as { connection: BleSession };
    const journal = TestBed.inject(BleJournalSync) as unknown as { connection: BleSession };
    const fixture = TestBed.createComponent(DeviceDiscovery);
    expect(monitor.connection).toBe(session); expect(journal.connection).toBe(session); expect(fixture.debugElement.injector.get(BLE_SESSION)).toBe(session);
    await vi.waitFor(() => expect(session.bindingLoading()).toBe(false));
    expect(bridge.start).not.toHaveBeenCalled(); expect(legacyConnect).not.toHaveBeenCalled(); fixture.destroy();
  });
  it('uses a browser session with no native calls, even for explicit actions or a binding coordinator', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    const initialize = vi.spyOn(BleClient, 'initialize'); const session = TestBed.inject(BLE_SESSION);
    expect(session).toBe(TestBed.inject(BrowserBleSession)); expect(TestBed.inject(BleConnection, null)).toBeNull();
    const fixture = TestBed.createComponent(DeviceDiscovery); fixture.detectChanges(); TestBed.inject(Co2Monitor);
    const client = session.attachClient(); await expect(client.connect('AA:BB:CC:DD:EE:01')).rejects.toThrow('Android');
    await client.disconnect(); await client.disconnectByUser(); expect(() => client.journal()).toThrow('Android');
    await expect(TestBed.inject(NativeBleBinding).migrate()).rejects.toThrow('Android');
    expect(() => TestBed.inject(NativeBleSession).attachClient()).toThrow('unavailable');
    expect(initialize).not.toHaveBeenCalled(); for (const method of Object.values(bridge)) expect(method).not.toHaveBeenCalled(); fixture.destroy();
  });
});
