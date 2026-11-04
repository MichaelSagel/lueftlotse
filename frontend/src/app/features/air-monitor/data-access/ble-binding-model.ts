import { uuidBytes } from '../ble-protocol/binary';

export interface BleBinding {
  readonly version: 1;
  readonly deviceId: string;
  readonly bleAddress: string;
  readonly connectionEnabled: boolean;
}

export function validatedBleBinding(value: unknown): BleBinding | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new Error('Invalid BLE binding');
  const binding = value as Partial<BleBinding>;
  if (binding.version !== 1 || typeof binding.deviceId !== 'string' ||
      typeof binding.bleAddress !== 'string' || !binding.bleAddress.trim() || binding.bleAddress.length > 256 ||
      typeof binding.connectionEnabled !== 'boolean') throw new Error('Invalid BLE binding');
  uuidBytes(binding.deviceId);
  return Object.freeze({ version: 1, deviceId: binding.deviceId.toLowerCase(),
    bleAddress: binding.bleAddress, connectionEnabled: binding.connectionEnabled });
}
