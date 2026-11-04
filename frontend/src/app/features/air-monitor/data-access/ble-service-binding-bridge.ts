import { InjectionToken } from '@angular/core';
import { registerPlugin } from '@capacitor/core';
import { BleBinding, validatedBleBinding } from './ble-binding-model';

export interface NativeBindingState {
  readonly migrationComplete: boolean;
  readonly revision: string;
  readonly binding: BleBinding | null;
}

/** Explicit commands only. There is intentionally no general-purpose write/save binding API. */
export interface BleServiceBindingBridge {
  getBinding(): Promise<NativeBindingState>;
  migrateBinding(input: { binding: BleBinding | null }): Promise<NativeBindingState>;
  forgetBinding(input: { revision: string }): Promise<NativeBindingState>;
}
export const nativeBindingBridge = registerPlugin<BleServiceBindingBridge>('BleService');
export const BLE_SERVICE_BINDING_BRIDGE = new InjectionToken<BleServiceBindingBridge>('BLE_SERVICE_BINDING_BRIDGE', {
  providedIn: 'root', factory: () => nativeBindingBridge,
});

export function validatedNativeBinding(value: unknown): NativeBindingState {
  if (!value || typeof value !== 'object') throw new Error('Invalid native binding state');
  const state = value as Partial<NativeBindingState>;
  if (typeof state.migrationComplete !== 'boolean' || typeof state.revision !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/.test(state.revision) || BigInt(state.revision) > (1n << 64n) - 1n ||
      !Object.hasOwn(state, 'binding') || state.binding === undefined) throw new Error('Invalid native binding state');
  const binding = validatedBleBinding(state.binding);
  if (binding && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(binding.bleAddress)) throw new Error('Invalid native BLE address');
  if (state.migrationComplete ? state.revision === '0' : state.revision !== '0' || binding !== null) throw new Error('Invalid native migration marker');
  return Object.freeze({ migrationComplete: state.migrationComplete, revision: state.revision, binding });
}
