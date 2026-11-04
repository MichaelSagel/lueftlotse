import { TestBed } from '@angular/core/testing';
import { WebBluetoothAdapter } from './web-bluetooth-adapter';
import { GATT } from '../ble-protocol/codec';
import { browserBleBinding } from './browser-ble-binding';
describe('Web Bluetooth boundary', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function setup(requestDevice = vi.fn()) {
    vi.stubGlobal('isSecureContext', true); vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
    TestBed.configureTestingModule({ providers: [WebBluetoothAdapter] }); return TestBed.inject(WebBluetoothAdapter);
  }
  it('requests the exact service immediately and treats cancellation as normal', async () => {
    const request = vi.fn().mockRejectedValue(new DOMException('cancel', 'NotFoundError')), adapter = setup(request);
    const result = adapter.choose(); expect(request).toHaveBeenCalledWith({ filters: [{ services: [GATT.service] }] });
    expect(await result).toBeNull(); expect(adapter.error()).toBeNull();
  });
  it('explains secure context and unavailable API without requesting a device', async () => {
    const request = vi.fn(), adapter = setup(request); vi.stubGlobal('isSecureContext', false);
    await adapter.choose(); expect(adapter.error()).toContain('HTTPS'); expect(request).not.toHaveBeenCalled();
    vi.stubGlobal('isSecureContext', true); vi.stubGlobal('navigator', {}); expect(adapter.message()).toContain('Chrome');
  });
  it('keeps binding entirely in memory and rejects a different identity', async () => {
    const storage = vi.fn(); vi.stubGlobal('indexedDB', { open: storage });
    const binding = browserBleBinding(); await binding.remember('first', 'opaque-id', new AbortController().signal);
    expect(() => binding.assertIdentity('second')).toThrow('UUID'); expect(browserBleBinding().saved()).toBeNull();
    await binding.disableConnection(); await binding.forget(); expect(storage).not.toHaveBeenCalled();
  });
  it('closes a late cancelled connect and never admits a second owner', async () => {
    let finish!: () => void;
    const device = Object.assign(new EventTarget(), { id: 'opaque', gatt: { connect: vi.fn(() => new Promise<void>(resolve => finish = resolve)), disconnect: vi.fn() } });
    const adapter = setup(vi.fn().mockResolvedValue(device)); await adapter.choose();
    const first = adapter.connect('opaque', vi.fn()); await expect(adapter.connect('opaque', vi.fn())).rejects.toThrow();
    await adapter.disconnect('opaque'); finish(); await expect(first).rejects.toThrow('Veraltete'); expect(device.gatt.disconnect).toHaveBeenCalledTimes(2);
  });
  it('orders Info, Events and response writes, copies notifications and removes old callbacks', async () => {
    const events = Object.assign(new EventTarget(), { value: new DataView(new Uint8Array([1, 2]).buffer),
      startNotifications: vi.fn(async () => events), stopNotifications: vi.fn(async () => events) });
    const control = { writeValueWithResponse: vi.fn(async () => {}) };
    const info = { readValue: vi.fn(async () => new DataView(new ArrayBuffer(20))) };
    const getCharacteristic = vi.fn(async (uuid: string) => uuid === GATT.info ? info : uuid === GATT.events ? events : control);
    const server = { connect: vi.fn(async () => server), disconnect: vi.fn(), getPrimaryService: vi.fn(async () => ({ getCharacteristic })) };
    const device = Object.assign(new EventTarget(), { id: 'opaque', gatt: server });
    const adapter = setup(vi.fn().mockResolvedValue(device)), disconnected = vi.fn(), receive = vi.fn();
    await adapter.choose(); await adapter.connect('opaque', disconnected); await adapter.readInfo('opaque');
    await adapter.subscribe('opaque', receive); await adapter.write('opaque', new DataView(new Uint8Array([3]).buffer));
    expect(getCharacteristic.mock.calls.map(call => call[0])).toEqual([GATT.info, GATT.events, GATT.control]);
    expect(control.writeValueWithResponse).toHaveBeenCalledWith(new Uint8Array([3]));
    events.dispatchEvent(new Event('characteristicvaluechanged')); events.value.setUint8(0, 9);
    expect(receive.mock.calls[0][0].getUint8(0)).toBe(1);
    await adapter.unsubscribe('opaque'); await adapter.disconnect('opaque');
    events.dispatchEvent(new Event('characteristicvaluechanged')); device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(receive).toHaveBeenCalledOnce(); expect(disconnected).not.toHaveBeenCalled();
  });
});
