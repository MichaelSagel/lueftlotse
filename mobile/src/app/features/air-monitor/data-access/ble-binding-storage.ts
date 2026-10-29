import { InjectionToken } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BleBinding, validatedBleBinding } from './ble-binding-model';
import { nativeBindingBridge, validatedNativeBinding } from './ble-service-binding-bridge';
export type { BleBinding } from './ble-binding-model';

export interface BleBindingStorage {
  read(): Promise<unknown>;
  write(binding: BleBinding): Promise<void>;
  remove(): Promise<void>;
}
export interface BleBindingMigrationStorage {
  beginNativeMigration(): Promise<BleBinding | null>;
  completeNativeMigration(): Promise<void>;
}

/** Separate settings DB. Its writer tombstone is retained after the old record is removed. */
export function createBleBindingStorage(
  nativeRead: () => Promise<unknown> = () => {
    if (Capacitor.getPlatform() !== 'android') return Promise.reject(new Error('Native BLE binding is available only on Android'));
    return nativeBindingBridge.getBinding();
  },
): BleBindingStorage & BleBindingMigrationStorage {
  const key = 'ble-binding', retiredKey = 'ble-binding-native-owner';
  function transaction<T>(mode: IDBTransactionMode,
    run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('lueftlotse-device', 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error('BLE binding database blocked')); };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) { database.close(); return; }
        try {
          const tx = database.transaction('settings', mode);
          let value: T, failure: unknown;
          const fail = (error: unknown) => { failure = error; tx.abort(); };
          tx.oncomplete = () => { database.close(); resolve(value); };
          tx.onabort = () => { database.close(); reject(failure ?? tx.error ?? new Error('BLE binding transaction aborted')); };
          try { run(tx.objectStore('settings'), result => { value = result; }, fail); }
          catch (error) { fail(error); }
        } catch (error) { database.close(); reject(error); }
      };
    });
  }
  function retired(store: IDBObjectStore, fail: (error: unknown) => void, next: (value: boolean) => void) {
    const request = store.get(retiredKey);
    request.onsuccess = () => {
      try {
        if (request.result !== undefined && request.result !== true) throw new Error('Invalid BLE binding owner marker');
        next(request.result === true);
      } catch (error) { fail(error); }
    };
  }
  function legacyMutation(operation: (store: IDBObjectStore) => void): Promise<void> {
    return transaction('readwrite', (store, done, fail) => retired(store, fail, isRetired => {
      if (isRetired) throw new Error('BLE binding is owned by the native repository');
      operation(store); done(undefined);
    }));
  }
  return {
    read: async () => {
      const value = await transaction<{ native: boolean; binding?: unknown }>('readonly', (store, done, fail) => retired(store, fail, isRetired => {
        if (isRetired) { done({ native: true }); return; }
        const request = store.get(key); request.onsuccess = () => done({ native: false, binding: request.result });
      }));
      if (!value.native) return value.binding;
      const native = validatedNativeBinding(await nativeRead());
      if (!native.migrationComplete) throw new Error('BLE binding migration is incomplete; resume explicitly');
      return native.binding;
    },
    write: binding => legacyMutation(store => { store.put(binding, key); }),
    remove: () => legacyMutation(store => { store.delete(key); }),
    beginNativeMigration: () => transaction('readwrite', (store, done, fail) => retired(store, fail, () => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const binding = validatedBleBinding(request.result);
          if (binding && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(binding.bleAddress)) throw new Error('Invalid Android BLE address');
          store.put(true, retiredKey); done(binding);
        } catch (error) { fail(error); }
      };
    })),
    // Only the migration coordinator calls this after a confirmed native snapshot.
    completeNativeMigration: () => transaction('readwrite', (store, done) => {
      store.put(true, retiredKey); store.delete(key); done(undefined);
    }),
  };
}

export const BLE_BINDING_STORAGE = new InjectionToken<BleBindingStorage>('BLE_BINDING_STORAGE', {
  providedIn: 'root', factory: createBleBindingStorage,
});
export const BLE_BINDING_MIGRATION_STORAGE = new InjectionToken<BleBindingMigrationStorage>('BLE_BINDING_MIGRATION_STORAGE', {
  providedIn: 'root', factory: createBleBindingStorage,
});
