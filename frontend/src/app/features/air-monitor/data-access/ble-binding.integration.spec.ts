import { TestBed } from '@angular/core/testing';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { encodeInfo, Message } from '../ble-protocol/codec';
import { fragmentMessage } from '../ble-protocol/fragments';
import { BLE_ADAPTER, BleAdapter } from './ble-adapter';
import { BLE_BINDING_STORAGE, BleBindingStorage } from './ble-binding-storage';
import { BleBindingStore } from './ble-binding';
import { BleConnection } from './ble-connection';
import { BleScanner } from './ble-scanner';
import { Co2Storage } from './co2-storage';

const deviceId = '00112233-4455-4677-8899-aabbccddeeff';
const otherId = '11223344-5566-4788-99aa-bbccddeeff00';
const address = 'AA:BB:CC:DD:EE:01';
const nextAddress = 'AA:BB:CC:DD:EE:02';
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const expected = (connectionEnabled = true, bleAddress = address) => ({ version: 1, deviceId, bleAddress, connectionEnabled });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Persisted BLE binding with the real session and IndexedDB', () => {
  let connection: BleConnection;
  let adapter: BleAdapter;
  let storage: BleBindingStorage;
  let identity: string;
  let notify: (value: DataView) => void;
  let lost: () => void;
  let eventId: number;
  let scanStop: ReturnType<typeof vi.fn>;
  function emit(message: Message) {
    for (const frame of fragmentMessage(message, eventId++, 'events')) notify(view(frame));
  }
  function status(requestId = 0): void {
    emit({ type: 0x80, requestId, bootId: deviceId, oldest: 0n, latest: 0n,
      overwrittenThrough: 0n, timeValid: 0, firstUndated: 0n, storageState: 0 });
  }
  function configure(): void {
    TestBed.configureTestingModule({ providers: [BleConnection,
      { provide: BLE_ADAPTER, useValue: adapter }, { provide: BleScanner, useValue: { stop: scanStop } }] });
    connection = TestBed.inject(BleConnection); storage = TestBed.inject(BLE_BINDING_STORAGE);
  }
  async function restart(): Promise<void> {
    await connection.disconnect(); TestBed.resetTestingModule();
    vi.mocked(adapter.connect).mockClear(); scanStop.mockClear();
    configure(); await TestBed.inject(BleBindingStore).ready();
  }
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    identity = deviceId; scanStop = vi.fn(async () => {});
    adapter = {
      available: () => true, initialize: vi.fn(async () => {}),
      connect: vi.fn(async (_, callback) => { lost = callback; eventId = 0; }),
      readInfo: vi.fn(async () => view(encodeInfo(identity, 16, 1))),
      subscribe: vi.fn(async (_, callback) => { notify = callback; }),
      unsubscribe: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
      write: vi.fn(async (_, frame) => { status(frame.getUint16(2, true)); }),
    };
    configure();
  });
  afterEach(async () => {
    await connection.disconnect().catch(() => {}); TestBed.resetTestingModule();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('restores identity, address and intent after a new injector without starting BLE', async () => {
    await TestBed.inject(BleBindingStore).ready(); expect(connection.binding()).toBeNull();
    expect(adapter.connect).not.toHaveBeenCalled();
    await connection.connect(address); expect(await storage.read()).toEqual(expected());
    await restart(); expect(connection.binding()).toEqual(expected());
    expect(connection.info()).toBeNull(); expect(connection.state()).toBe('idle');
    expect(adapter.connect).not.toHaveBeenCalled(); expect(scanStop).not.toHaveBeenCalled();
  });

  it('does not remember Info, unsolicited STATUS or matching STATUS before the write completes', async () => {
    const write = deferred();
    vi.mocked(adapter.write).mockImplementationOnce(async () => { status(65535); status(17); await write.promise; });
    const pending = connection.connect(address);
    await vi.waitFor(() => expect(adapter.write).toHaveBeenCalled());
    expect(connection.info()?.deviceId).toBe(deviceId); expect(await storage.read()).toBeUndefined();
    status(); await Promise.resolve();
    expect(await storage.read()).toBeUndefined(); expect(connection.state()).toBe('connecting');
    write.resolve(); await pending; expect(await storage.read()).toEqual(expected());
  });

  it('persists Trennen across restart and enables intent only after another successful manual handshake', async () => {
    await connection.connect(address); await connection.disconnectByUser();
    expect(await storage.read()).toEqual(expected(false));
    await restart(); expect(connection.binding()).toEqual(expected(false));
    expect(adapter.connect).not.toHaveBeenCalled();
    await connection.connect(address); expect(await storage.read()).toEqual(expected());
  });

  it.each([address, nextAddress])('rejects a foreign UUID at %s without replacing the saved binding', async candidate => {
    await connection.connect(address); await connection.disconnectByUser(); identity = otherId;
    vi.mocked(adapter.subscribe).mockClear();
    await expect(connection.connect(candidate)).rejects.toThrow('binding UUID mismatch');
    await connection.disconnect();
    expect(adapter.subscribe).not.toHaveBeenCalled(); expect(await storage.read()).toEqual(expected(false));
    expect(connection.binding()).toEqual(expected(false));
  });

  it('updates the address of the same UUID only after a successful new handshake', async () => {
    await connection.connect(address); await connection.disconnectByUser();
    const write = vi.mocked(adapter.write); write.mockClear(); write.mockResolvedValueOnce();
    const pending = connection.connect(nextAddress); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(await storage.read()).toEqual(expected(false));
    await connection.disconnect(); await rejected;
    expect(await storage.read()).toEqual(expected(false));
    await connection.connect(nextAddress); expect(await storage.read()).toEqual(expected(true, nextAddress));
  });

  it.each(['radio loss', 'background', 'scope destruction'])('preserves intent after %s without reconnecting', async reason => {
    await connection.connect(address);
    if (reason === 'radio loss') lost();
    else if (reason === 'background') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    } else TestBed.resetTestingModule();
    await connection.disconnect();
    expect(await storage.read()).toEqual(expected()); expect(adapter.connect).toHaveBeenCalledTimes(1);
  });

  it('forgets a connected sensor, retains history and allows a different sensor to be selected', async () => {
    const history = new Co2Storage();
    try {
      await history.append({ time: Date.now(), ppm: 700, segment: 'existing' });
      await connection.connect(address); await connection.forgetDevice();
      expect(adapter.unsubscribe).toHaveBeenCalledOnce(); expect(adapter.disconnect).toHaveBeenCalledOnce();
      expect(await storage.read()).toBeUndefined(); expect(connection.binding()).toBeNull();
      expect(await history.count()).toBe(1);
      await restart(); expect(connection.binding()).toBeNull(); expect(adapter.connect).not.toHaveBeenCalled();
      identity = otherId; await connection.connect(nextAddress);
      expect(connection.binding()).toEqual({ ...expected(true, nextAddress), deviceId: otherId });
      await history.clear(); expect(await storage.read()).toEqual(connection.binding());
    } finally { await history.close(); }
  });

  it.each(['disconnect', 'forget'] as const)('does not save a late STATUS after explicit %s', async action => {
    vi.mocked(adapter.write).mockResolvedValue();
    const pending = connection.connect(address); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(adapter.write).toHaveBeenCalled());
    await (action === 'forget' ? connection.forgetDevice() : connection.disconnectByUser());
    await rejected; status();
    expect(await storage.read()).toBeUndefined(); expect(connection.binding()).toBeNull();
  });

  it.each(['disconnect', 'forget'] as const)('serializes %s after a pending binding write and blocks a replacement session', async action => {
    const original = storage.write.bind(storage); const gate = deferred();
    const write = vi.spyOn(storage, 'write').mockImplementationOnce(async value => { await gate.promise; await original(value); });
    const pending = connection.connect(address); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    const stopping = action === 'forget' ? connection.forgetDevice() : connection.disconnectByUser();
    await expect(connection.connect(nextAddress)).rejects.toThrow('unavailable');
    gate.resolve(); await stopping; await rejected;
    expect(await storage.read()).toEqual(action === 'forget' ? undefined : expected(false));
  });

  it('reports a failed binding write and closes instead of announcing readiness', async () => {
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('quota'));
    const events: string[] = []; connection.previewEvents.subscribe(event => events.push(event.kind));
    await expect(connection.connect(address)).rejects.toThrow('binding storage'); await connection.disconnect();
    expect(events).not.toContain('ready'); expect(await storage.read()).toBeUndefined();
    expect(connection.binding()).toBeNull(); expect(adapter.disconnect).toHaveBeenCalledOnce();
  });

  it('still closes on failed intent persistence, retains the prior record and allows retry', async () => {
    await connection.connect(address);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('quota'));
    await expect(connection.disconnectByUser()).rejects.toThrow('binding storage');
    expect(adapter.disconnect).toHaveBeenCalledOnce(); expect(await storage.read()).toEqual(expected());
    await connection.disconnectByUser(); expect(await storage.read()).toEqual(expected(false));
  });

  it('keeps intent disabled if forgetting fails and removes the binding on explicit retry', async () => {
    await connection.connect(address);
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new Error('disk failure'));
    await expect(connection.forgetDevice()).rejects.toThrow('binding storage');
    expect(adapter.disconnect).toHaveBeenCalledOnce(); expect(await storage.read()).toEqual(expected(false));
    await connection.forgetDevice(); expect(await storage.read()).toBeUndefined(); expect(connection.bindingError()).toBeNull();
  });

  it('rejects an unreadable stored binding without silently overwriting it', async () => {
    await connection.connect(address);
    await storage.write({ ...expected(), version: 2 } as never);
    await connection.disconnect(); TestBed.resetTestingModule(); configure();
    vi.mocked(adapter.initialize).mockClear();
    await expect(connection.connect(address)).rejects.toThrow('binding storage'); await connection.disconnect();
    expect(adapter.initialize).not.toHaveBeenCalled(); expect((await storage.read() as { version: number }).version).toBe(2);
    await connection.forgetDevice(); expect(await storage.read()).toBeUndefined();
    await connection.connect(address); expect(connection.binding()).toEqual(expected());
  });

  it('does not persist LIVE_SAMPLE fields or write settings for preview traffic', async () => {
    const write = vi.spyOn(storage, 'write'); await connection.connect(address);
    for (let counter = 1n; counter <= 3n; counter++) {
      emit({ type: 0x8a, bootId: deviceId, sampleCounter: counter, uptimeMs: counter * 5000n, ppm: 2100 });
    }
    expect(write).toHaveBeenCalledTimes(1); expect(await storage.read()).toEqual(expected());
  });
});
