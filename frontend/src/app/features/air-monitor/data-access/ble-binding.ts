import { Injectable, inject, signal } from '@angular/core';
import { BLE_BINDING_STORAGE, BleBinding } from './ble-binding-storage';
import { validatedBleBinding as validated } from './ble-binding-model';

/** One remembered identity, independent of transport lifetime and preview samples. */
@Injectable({ providedIn: 'root' })
export class BleBindingStore {
  private readonly storage = inject(BLE_BINDING_STORAGE);
  private readonly value = signal<BleBinding | null>(null);
  readonly saved = this.value.asReadonly();
  readonly error = signal<string | null>(null);
  readonly loading = signal(true);
  private unreadable = false;
  private tail: Promise<unknown> = this.restore();

  private async restore(): Promise<void> {
    try { this.value.set(validated(await this.storage.read())); }
    catch { this.unreadable = true; this.error.set('BLE binding storage could not be read'); }
    finally { this.loading.set(false); }
  }

  async ready(): Promise<void> {
    await this.tail;
    this.assertReadable();
  }

  assertIdentity(deviceId: string): void {
    this.assertReadable();
    if (this.saved() && this.saved()!.deviceId !== deviceId.toLowerCase()) {
      throw new Error('BLE binding UUID mismatch');
    }
  }

  /** Called only after STATUS and its Control write have both completed. */
  remember(deviceId: string, bleAddress: string, signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      signal.throwIfAborted();
      this.assertIdentity(deviceId);
      const binding = validated({ version: 1, deviceId, bleAddress, connectionEnabled: true })!;
      await this.write(binding);
    });
  }

  disableConnection(): Promise<void> {
    return this.enqueue(async () => {
      this.assertReadable();
      const binding = this.saved();
      if (binding?.connectionEnabled) await this.write({ ...binding, connectionEnabled: false });
    });
  }

  forget(): Promise<void> {
    return this.enqueue(async () => {
      // If removal fails, retain the identity with connection intent disabled.
      const binding = this.saved();
      if (binding?.connectionEnabled) await this.write({ ...binding, connectionEnabled: false });
      try { await this.storage.remove(); }
      catch { throw this.storageError('could not be removed'); }
      this.value.set(null); this.unreadable = false; this.error.set(null);
    });
  }

  private assertReadable(): void {
    if (this.unreadable) throw new Error('BLE binding storage could not be read');
  }
  private async write(binding: BleBinding): Promise<void> {
    try { await this.storage.write(binding); }
    catch { throw this.storageError('could not be saved'); }
    this.value.set(Object.freeze(binding)); this.error.set(null);
  }
  private storageError(detail: string): Error {
    const error = new Error('BLE binding storage ' + detail);
    this.error.set(error.message); return error;
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
}
