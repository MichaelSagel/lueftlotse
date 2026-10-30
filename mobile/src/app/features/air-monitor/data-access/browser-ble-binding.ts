import { signal } from '@angular/core';
import { BleBinding } from './ble-binding-model';
export function browserBleBinding() {
  const saved = signal<BleBinding | null>(null);
  const assertIdentity = (id: string) => { if (saved() && saved()!.deviceId !== id) throw new Error('BLE binding UUID mismatch'); };
  return { saved, error: signal<string | null>(null), loading: signal(false), ready: async () => {}, assertIdentity,
    remember: async (deviceId: string, bleAddress: string, signal: AbortSignal) => { signal.throwIfAborted(); assertIdentity(deviceId); saved.set({ version: 1, deviceId, bleAddress, connectionEnabled: true }); },
    disableConnection: async () => { const value = saved(); if (value) saved.set({ ...value, connectionEnabled: false }); },
    forget: async () => { saved.set(null); } };
}
