import { vi } from 'vitest';
import { BLE_BINDING_STORAGE, BleBinding, BleBindingStorage } from './ble-binding-storage';

export function testBleBindingStorage(initial: unknown = undefined) {
  let value = structuredClone(initial);
  const storage = {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (binding: BleBinding) => { value = structuredClone(binding); }),
    remove: vi.fn(async () => { value = undefined; }),
  } satisfies BleBindingStorage;
  return { storage, saved: () => structuredClone(value), provider: { provide: BLE_BINDING_STORAGE, useValue: storage } };
}
