import { TestBed } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { BleBinding } from './ble-binding-model';
import { BLE_BINDING_MIGRATION_STORAGE, createBleBindingStorage } from './ble-binding-storage';
import { BLE_SERVICE_BINDING_BRIDGE, NativeBindingState, validatedNativeBinding } from './ble-service-binding-bridge';
import { NativeBleBinding } from './native-ble-binding';

const binding: BleBinding = { version: 1, deviceId: '00112233-4455-4677-8899-aabbccddeeff',
  bleAddress: 'AA:BB:CC:DD:EE:01', connectionEnabled: true };
const initial = (): NativeBindingState => ({ migrationComplete: false, revision: '0', binding: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

describe('Explicit native BLE binding migration', () => {
  let native: NativeBindingState;
  let legacy: ReturnType<typeof createBleBindingStorage>;
  let client: NativeBleBinding;
  const bridge = {
    getBinding: vi.fn<() => Promise<NativeBindingState>>(),
    migrateBinding: vi.fn<(input: { binding: BleBinding | null }) => Promise<NativeBindingState>>(),
    forgetBinding: vi.fn<(input: { revision: string }) => Promise<NativeBindingState>>(),
  };
  function configure() {
    TestBed.configureTestingModule({ providers: [
      { provide: BLE_SERVICE_BINDING_BRIDGE, useValue: bridge },
      { provide: BLE_BINDING_MIGRATION_STORAGE, useValue: legacy },
    ] });
    client = TestBed.inject(NativeBleBinding);
  }
  async function rawRecord(write?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('lueftlotse-device', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('settings', write === undefined ? 'readonly' : 'readwrite');
        const store = tx.objectStore('settings');
        const request = write === undefined ? store.get('ble-binding') : store.put(write, 'ble-binding');
        tx.oncomplete = () => { db.close(); resolve(request.result); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); native = initial(); vi.resetAllMocks();
    bridge.getBinding.mockImplementation(async () => structuredClone(native));
    bridge.migrateBinding.mockImplementation(async input => {
      if (!native.migrationComplete) native = { migrationComplete: true, revision: '1', binding: structuredClone(input.binding) };
      return structuredClone(native);
    });
    bridge.forgetBinding.mockImplementation(async input => {
      if (native.revision !== input.revision) throw new Error('Stale revision');
      native = { migrationComplete: true, revision: String(BigInt(native.revision) + 1n), binding: null };
      return structuredClone(native);
    });
    legacy = createBleBindingStorage(() => bridge.getBinding()); configure();
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('does not migrate, read native state or start BLE during construction or ordinary legacy IO', async () => {
    expect(client.state()).toBeNull(); await legacy.write(binding); expect(await legacy.read()).toEqual(binding);
    expect(bridge.getBinding).not.toHaveBeenCalled(); expect(bridge.migrateBinding).not.toHaveBeenCalled();
  });
  it('retains the old record until native acknowledgement, and freezes competing legacy writers', async () => {
    await legacy.write(binding); const commit = deferred<NativeBindingState>();
    bridge.migrateBinding.mockImplementationOnce(() => commit.promise);
    const pending = client.migrate(); await vi.waitFor(() => expect(bridge.migrateBinding).toHaveBeenCalledOnce());
    expect(await rawRecord()).toEqual(binding);
    const otherPage = createBleBindingStorage(() => bridge.getBinding());
    await expect(otherPage.write({ ...binding, connectionEnabled: false })).rejects.toThrow('native repository');
    await expect(otherPage.remove()).rejects.toThrow('native repository');
    native = { migrationComplete: true, revision: '1', binding }; commit.resolve(native);
    expect(await pending).toEqual(native); expect(await rawRecord()).toBeUndefined(); expect(await otherPage.read()).toEqual(binding);
  });
  it('resumes after interruption between the IDB writer fence and native commit', async () => {
    await legacy.write(binding); await legacy.beginNativeMigration();
    await expect(legacy.read()).rejects.toThrow('incomplete');
    TestBed.resetTestingModule(); configure(); await client.migrate();
    expect(bridge.migrateBinding).toHaveBeenCalledWith({ binding }); expect(await rawRecord()).toBeUndefined();
  });
  it('keeps legacy data when native write fails, and can explicitly retry', async () => {
    await legacy.write(binding); bridge.migrateBinding.mockRejectedValueOnce(new Error('disk full'));
    await expect(client.migrate()).rejects.toThrow('disk full'); expect(await rawRecord()).toEqual(binding);
    expect(client.error()).toBe('disk full'); expect(native.migrationComplete).toBe(false);
    await client.migrate(); expect(native.binding).toEqual(binding); expect(client.error()).toBeNull();
  });
  it('recovers a lost bridge reply after native commit without importing again', async () => {
    await legacy.write(binding); bridge.migrateBinding.mockImplementationOnce(async input => {
      native = { migrationComplete: true, revision: '1', binding: input.binding }; throw new Error('reply lost');
    });
    await expect(client.migrate()).rejects.toThrow('reply lost'); expect(await rawRecord()).toEqual(binding);
    TestBed.resetTestingModule(); configure(); await client.migrate();
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(await rawRecord()).toBeUndefined(); expect(client.state()).toEqual(native);
  });
  it('retries IDB deletion without changing the native revision or replaying import', async () => {
    await legacy.write(binding); vi.spyOn(legacy, 'completeNativeMigration').mockRejectedValueOnce(new Error('IDB commit failed'));
    await expect(client.migrate()).rejects.toThrow('IDB commit failed'); expect(await rawRecord()).toEqual(binding);
    const revision = native.revision; await client.migrate();
    expect(native.revision).toBe(revision); expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(await rawRecord()).toBeUndefined();
  });
  it('migrates an empty database once, preserving the permanent empty marker', async () => {
    await client.migrate(); expect(bridge.migrateBinding).toHaveBeenCalledWith({ binding: null });
    expect(client.state()).toEqual({ migrationComplete: true, revision: '1', binding: null });
    await rawRecord(binding); TestBed.resetTestingModule(); configure(); await client.migrate();
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(await legacy.read()).toBeNull(); expect(await rawRecord()).toBeUndefined();
  });
  it('does not treat native read failure as an empty binding or delete legacy data', async () => {
    await legacy.write(binding); bridge.getBinding.mockRejectedValueOnce(new Error('native read failed'));
    await expect(client.migrate()).rejects.toThrow('native read failed');
    expect(bridge.migrateBinding).not.toHaveBeenCalled(); expect(await rawRecord()).toEqual(binding);
  });
  it('does not treat an IndexedDB read/open failure as an empty migration', async () => {
    await legacy.write(binding); const open = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw new Error('IDB read denied'); });
    await expect(client.migrate()).rejects.toThrow('IDB read denied'); open.mockRestore();
    expect(bridge.migrateBinding).not.toHaveBeenCalled(); expect(await rawRecord()).toEqual(binding);
  });
  it('rejects corrupt legacy data without retiring or overwriting it', async () => {
    await legacy.write(binding); await rawRecord({ ...binding, version: 9 });
    await expect(client.migrate()).rejects.toThrow('Invalid BLE binding'); expect(bridge.migrateBinding).not.toHaveBeenCalled();
    await legacy.write(binding); await client.migrate(); expect(native.binding).toEqual(binding);
  });
  it('requires a valid completion marker and revision before deleting the old record', async () => {
    await legacy.write(binding); bridge.migrateBinding.mockResolvedValueOnce(initial());
    await expect(client.migrate()).rejects.toThrow('not confirmed'); expect(await rawRecord()).toEqual(binding);
  });
  it('reads only through the bridge after migration, including a new Angular injector', async () => {
    await legacy.write(binding); await client.migrate();
    native = { migrationComplete: true, revision: '2', binding: { ...binding, connectionEnabled: false } };
    TestBed.resetTestingModule(); configure(); expect(client.state()).toBeNull();
    expect((await client.refresh()).binding?.connectionEnabled).toBe(false);
    expect((await legacy.read() as BleBinding).connectionEnabled).toBe(false);
    bridge.getBinding.mockRejectedValueOnce(new Error('native unreadable'));
    await expect(legacy.read()).rejects.toThrow('native unreadable');
  });
  it('forget retains native ownership and old IndexedDB data cannot restore a device', async () => {
    await legacy.write(binding); await client.migrate(); await client.forget();
    expect(bridge.forgetBinding).toHaveBeenCalledWith({ revision: '1' }); expect(native.migrationComplete).toBe(true);
    await rawRecord(binding); await client.migrate(); expect(native.binding).toBeNull();
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(await legacy.read()).toBeNull();
    await expect(legacy.write(binding)).rejects.toThrow('native repository');
  });
  it('a failed forget never deletes the old record or claims success', async () => {
    await legacy.write(binding); bridge.forgetBinding.mockRejectedValueOnce(new Error('forget failed'));
    await expect(client.forget()).rejects.toThrow('forget failed'); expect(await rawRecord()).toEqual(binding);
    expect(client.error()).toBe('forget failed');
    await expect(legacy.write(binding)).rejects.toThrow('native repository');
    await client.forget(); expect(native.migrationComplete).toBe(true); expect(await rawRecord()).toBeUndefined();
  });
  it('recovers when deletion completed but the final native read failed', async () => {
    await legacy.write(binding);
    bridge.getBinding.mockResolvedValueOnce(initial()).mockRejectedValueOnce(new Error('final read lost'));
    await expect(client.migrate()).rejects.toThrow('final read lost'); expect(await rawRecord()).toBeUndefined();
    expect(native.migrationComplete).toBe(true); await client.migrate();
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(client.state()).toEqual(native);
  });
  it('serializes simultaneous migration requests and performs only one import', async () => {
    await legacy.write(binding); await Promise.all([client.migrate(), client.migrate()]);
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(native.revision).toBe('1');
  });
  it('preserves uint64 revisions as strings and rejects lossy or malformed bridge states', () => {
    expect(validatedNativeBinding({ migrationComplete: true, revision: '18446744073709551615', binding: null }).revision).toBe('18446744073709551615');
    for (const revision of [1, '01', '-1', '18446744073709551616']) {
      expect(() => validatedNativeBinding({ migrationComplete: true, revision, binding: null })).toThrow();
    }
    expect(() => validatedNativeBinding({ migrationComplete: true, revision: '1' })).toThrow();
  });
});
