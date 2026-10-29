import { Injectable, inject, signal } from '@angular/core';
import { BLE_BINDING_MIGRATION_STORAGE } from './ble-binding-storage';
import { BLE_SERVICE_BINDING_BRIDGE, NativeBindingState, validatedNativeBinding } from './ble-service-binding-bridge';

/** Opt-in coordinator/reader; construction and application startup perform no migration. */
@Injectable({ providedIn: 'root' })
export class NativeBleBinding {
  private readonly bridge = inject(BLE_SERVICE_BINDING_BRIDGE);
  private readonly legacy = inject(BLE_BINDING_MIGRATION_STORAGE);
  private readonly value = signal<NativeBindingState | null>(null);
  readonly state = this.value.asReadonly();
  readonly error = signal<string | null>(null);
  private tail: Promise<unknown> = Promise.resolve();

  refresh(): Promise<NativeBindingState> { return this.enqueue(() => this.read()); }
  migrate(): Promise<NativeBindingState> {
    return this.enqueue(async () => {
      let saved = validatedNativeBinding(await this.bridge.getBinding());
      if (!saved.migrationComplete) {
        const binding = await this.legacy.beginNativeMigration();
        saved = validatedNativeBinding(await this.bridge.migrateBinding({ binding }));
      }
      if (!saved.migrationComplete) throw new Error('Native migration was not confirmed');
      // Confirm native persistence before deleting the old record and retaining the IDB writer guard.
      await this.legacy.completeNativeMigration();
      return this.read(); // Never publish the import candidate as the current source of truth.
    });
  }
  forget(): Promise<NativeBindingState> {
    return this.enqueue(async () => {
      const saved = validatedNativeBinding(await this.bridge.getBinding());
      if (!saved.migrationComplete) await this.legacy.beginNativeMigration();
      const forgotten = validatedNativeBinding(await this.bridge.forgetBinding({ revision: saved.revision }));
      if (!forgotten.migrationComplete || forgotten.binding !== null) throw new Error('Native forget was not confirmed');
      await this.legacy.completeNativeMigration();
      return this.read();
    });
  }
  private async read(): Promise<NativeBindingState> {
    const saved = validatedNativeBinding(await this.bridge.getBinding());
    this.value.set(saved); return saved;
  }
  private enqueue(action: () => Promise<NativeBindingState>): Promise<NativeBindingState> {
    const result = this.tail.then(action).then(value => { this.error.set(null); return value; }, error => {
      this.error.set(error instanceof Error ? error.message : 'Native binding storage error'); throw error;
    });
    this.tail = result.catch(() => {}); return result;
  }
}
