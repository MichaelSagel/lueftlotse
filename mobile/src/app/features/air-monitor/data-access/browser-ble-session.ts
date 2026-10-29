import { Injectable, signal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { BleBinding } from './ble-binding-model';
import { Info } from '../ble-protocol/codec';
import { BlePhase, BleSession, BleSessionClient, BleState, BleStatus } from './ble-session';

/** Browser history remains available. No native plugin, binding migration or transport is injected. */
@Injectable()
export class BrowserBleSession implements BleSession {
  readonly state = signal<BleState>('idle');
  readonly phase = signal<BlePhase>('idle');
  readonly info = signal<Info | null>(null);
  readonly status = signal<BleStatus | null>(null);
  readonly error = signal<string | null>(null);
  readonly binding = signal<BleBinding | null>(null);
  readonly bindingError = signal<string | null>(null);
  readonly bindingLoading = signal(false);
  readonly previewEvents = EMPTY;
  attachClient(): BleSessionClient {
    const client = new AbortController();
    const unavailable = () => { throw new Error('Bluetooth ist nur in der Android-App verfügbar.'); };
    return { id: crypto.randomUUID(), signal: client.signal, connect: async () => unavailable(),
      disconnect: async () => {}, disconnectByUser: async () => {}, forgetDevice: async () => unavailable(),
      journal: unavailable, revoke: () => client.abort() };
  }
}
