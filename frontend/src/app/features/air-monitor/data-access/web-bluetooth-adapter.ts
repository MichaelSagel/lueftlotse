import { Injectable, signal } from '@angular/core';
import { BleAdapter } from './ble-adapter';
import { GATT } from '../ble-protocol/codec';

// Local structural types: no additional package or native plugin is required.
interface Characteristic extends EventTarget {
  value?: DataView;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<Characteristic>;
  stopNotifications(): Promise<Characteristic>;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
}
interface Server { connect(): Promise<Server>; disconnect(): void; getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<Characteristic> }>; }
interface Device extends EventTarget { id: string; gatt?: Server; }
interface Bluetooth { requestDevice(options: { filters: { services: string[] }[] }): Promise<Device>; }
@Injectable()
export class WebBluetoothAdapter implements BleAdapter {
  readonly error = signal<string | null>(null);
  private device?: Device;
  private active?: { device: Device; server: Server; disconnected: () => void; events?: Characteristic; receive?: EventListener };
  private choosing = false;
  private connecting = false;
  message(): string | null {
    if (!globalThis.isSecureContext) return 'Bluetooth benötigt HTTPS oder localhost. Bitte die Seite über eine sichere Adresse öffnen.';
    if (!(navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth) return 'Web Bluetooth ist nicht verfügbar. Bitte Chrome unter Windows mit aktiviertem Bluetooth verwenden.';
    return null;
  }
  available(): boolean { return this.message() === null; }
  initialize(): Promise<void> { return Promise.resolve(); }
  // Called synchronously by the click handler, before any await/connection preparation.
  async choose(): Promise<string | null> {
    if (this.choosing || this.active || this.connecting) return null;
    const message = this.message(); if (message) { this.error.set(message); return null; }
    this.choosing = true; this.error.set(null);
    try {
      const device = await (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth.requestDevice({ filters: [{ services: [GATT.service] }] });
      this.device = device; return device.id;
    } catch (error) {
      if ((error as { name?: string }).name !== 'NotFoundError') this.error.set('Der Sensor konnte nicht ausgewählt werden. Bitte Bluetooth und die Browserberechtigung prüfen.');
      return null;
    } finally { this.choosing = false; }
  }
  async connect(id: string, disconnected: () => void): Promise<void> {
    if (this.active || this.connecting || !this.device?.gatt || this.device.id !== id) throw new Error('Bitte zuerst einen Sensor auswählen.');
    const device = this.device, server = device.gatt!;
    const run = { device, server, disconnected: () => { if (this.active === run) disconnected(); } };
    this.active = run; device.addEventListener('gattserverdisconnected', run.disconnected);
    this.connecting = true;
    try {
      await server.connect();
      if (this.active !== run) { server.disconnect(); throw new Error('Veraltete Bluetooth-Verbindung'); }
    } finally { this.connecting = false; }
  }
  private current(id: string) {
    if (!this.active || this.active.device.id !== id) throw new Error('Bluetooth ist nicht verbunden.');
    return this.active;
  }
  private async characteristic(id: string, uuid: string) {
    const run = this.current(id), service = await run.server.getPrimaryService(GATT.service);
    const characteristic = await service.getCharacteristic(uuid);
    if (this.active !== run) throw new Error('Veraltete Bluetooth-Verbindung');
    return characteristic;
  }
  async readInfo(id: string): Promise<DataView> { return (await this.characteristic(id, GATT.info)).readValue(); }
  async subscribe(id: string, receive: (value: DataView) => void): Promise<void> {
    const run = this.current(id), events = await this.characteristic(id, GATT.events);
    run.events = events; run.receive = () => {
      if (this.active !== run || !events.value) return;
      const value = events.value;
      receive(new DataView(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer));
    };
    events.addEventListener('characteristicvaluechanged', run.receive);
    await events.startNotifications();
  }
  async unsubscribe(id: string): Promise<void> {
    const run = this.current(id);
    if (run.events && run.receive) { run.events.removeEventListener('characteristicvaluechanged', run.receive); await run.events.stopNotifications(); }
  }
  async write(id: string, value: DataView): Promise<void> {
    await (await this.characteristic(id, GATT.control)).writeValueWithResponse(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  }
  async disconnect(id: string): Promise<void> {
    const run = this.active; if (!run || run.device.id !== id) return;
    this.active = undefined;
    run.device.removeEventListener('gattserverdisconnected', run.disconnected);
    if (run.events && run.receive) run.events.removeEventListener('characteristicvaluechanged', run.receive);
    run.server.disconnect();
  }
}
