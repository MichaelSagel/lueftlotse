import { InjectionToken } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { GATT } from '../ble-protocol/codec';

/** Native operations only. Protocol/session ownership belongs to BleConnection. */
export interface BleAdapter {
  available(): boolean;
  initialize(): Promise<void>;
  connect(id: string, disconnected: () => void): Promise<void>;
  readInfo(id: string): Promise<DataView>;
  subscribe(id: string, receive: (value: DataView) => void): Promise<void>;
  unsubscribe(id: string): Promise<void>;
  write(id: string, value: DataView): Promise<void>;
  disconnect(id: string): Promise<void>;
}

export const BLE_ADAPTER = new InjectionToken<BleAdapter>('BLE_ADAPTER', {
  providedIn: 'root',
  factory: () => ({
    available: () => Capacitor.getPlatform() === 'android',
    initialize: () => BleClient.initialize({ androidNeverForLocation: true }),
    connect: (id, disconnected) => BleClient.connect(id, disconnected, { timeout: 10000 }),
    readInfo: id => BleClient.read(id, GATT.service, GATT.info, { timeout: 5000 }),
    subscribe: (id, receive) => BleClient.startNotifications(id, GATT.service, GATT.events, receive, { timeout: 5000 }),
    unsubscribe: id => BleClient.stopNotifications(id, GATT.service, GATT.events),
    write: (id, value) => BleClient.write(id, GATT.service, GATT.control, value, { timeout: 5000 }),
    disconnect: id => BleClient.disconnect(id),
  }),
});
