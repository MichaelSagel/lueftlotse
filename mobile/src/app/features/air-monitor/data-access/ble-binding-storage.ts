import { InjectionToken } from '@angular/core';

export interface BleBinding {
  readonly version: 1;
  readonly deviceId: string;
  readonly bleAddress: string;
  readonly connectionEnabled: boolean;
}

export interface BleBindingStorage {
  read(): Promise<unknown>;
  write(binding: BleBinding): Promise<void>;
  remove(): Promise<void>;
}

/** Separate settings database: clearing measurement history cannot forget a device. */
export function createBleBindingStorage(): BleBindingStorage {
  function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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
          const operation = run(tx.objectStore('settings'));
          tx.oncomplete = () => { database.close(); resolve(operation.result); };
          tx.onabort = () => { database.close(); reject(tx.error ?? operation.error); };
        } catch (error) { database.close(); reject(error); }
      };
    });
  }
  return {
    read: () => transaction('readonly', store => store.get('ble-binding')),
    write: async binding => { await transaction('readwrite', store => store.put(binding, 'ble-binding')); },
    remove: async () => { await transaction('readwrite', store => store.delete('ble-binding')); },
  };
}

export const BLE_BINDING_STORAGE = new InjectionToken<BleBindingStorage>('BLE_BINDING_STORAGE', {
  providedIn: 'root', factory: createBleBindingStorage,
});
