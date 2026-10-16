import { Component, computed, inject, signal } from '@angular/core';
import { BleScanner } from '../../data-access/ble-scanner';
import { BleConnection } from '../../data-access/ble-connection';

@Component({
  selector: 'app-device-discovery',
  providers: [BleScanner, BleConnection],
  template: `
    <button type="button" (click)="toggle()" [attr.aria-expanded]="expanded()" aria-controls="ble-discovery">Gerät verbinden</button>
    <section id="ble-discovery" [hidden]="!expanded()" aria-label="Bluetooth-Geräte suchen">
      @if (scanner.available) {
        <p>BLE-Geräte in der Nähe suchen. Die Simulation läuft unabhängig weiter.</p>
        <button type="button" (click)="startScan()" [disabled]="busy() || scanner.busy() || scanner.state() === 'scanning' || connection.state() === 'ready'">Geräte suchen</button>
        @if (scanner.state() === 'scanning') {
          <button type="button" (click)="stopScan()">Suche stoppen</button>
        }
        <p role="status">{{ scanner.message() }}</p>
        <p role="status" class="connection-status">{{ phaseText() }}</p>
        @if (connection.state() === 'ready') {
          <p>Gerät verbunden · STATUS bestätigt. Es werden noch keine Sensormesswerte übernommen.</p>
          <p class="device-id">deviceId: {{ connection.info()?.deviceId }}</p>
        }
        @if (connection.state() === 'ready' || busy()) {
          <button type="button" class="disconnect" (click)="disconnect()" [disabled]="pending()">Trennen</button>
        }
        @if (errorText(); as error) { <p role="alert">{{ error }}</p> }
        <ul>
          @for (device of scanner.devices(); track device.id) {
            <li><strong>{{ device.name }}</strong><span>{{ device.id }}</span><span>RSSI: {{ device.rssi ?? '—' }} dBm</span>
              <button type="button" class="connect" (click)="connect(device.id)" [disabled]="busy() || scanner.busy()">Verbinden</button>
            </li>
          }
        </ul>
      } @else {
        <p>Die BLE-Suche ist in der Android-App verfügbar.</p>
      }
    </section>
  `,
  styles: `
    :host { display: block; margin-bottom: 24px; }
    button { width: 100%; min-height: 48px; padding: 12px; margin-bottom: 8px; border: 1px solid #163e2c; border-radius: 14px; background: white; color: #163e2c; font: inherit; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
    button:focus-visible { outline: 3px solid #17663e; outline-offset: 3px; }
    section { padding: 12px; border: 1px solid #b7cbc1; border-radius: 14px; font-size: 14px; line-height: 1.5; }
    ul { padding: 0; list-style: none; }
    li { padding: 12px 0; border-top: 1px solid #b7cbc1; overflow-wrap: anywhere; }
    li span { display: block; }
  `,
})
export class DeviceDiscovery {
  protected readonly scanner = inject(BleScanner);
  protected readonly connection = inject(BleConnection);
  protected readonly expanded = signal(false);
  protected readonly pending = signal(false);
  private readonly actionError = signal<string | null>(null);
  protected readonly busy = computed(() => this.pending() || this.connection.state() === 'connecting' || this.connection.phase() === 'closing');
  protected readonly phaseText = computed(() => ({
    idle: '', 'scan-stop': 'Suche wird beendet …', initialize: 'Bluetooth wird vorbereitet …',
    connect: 'Verbindung wird hergestellt …', info: 'Geräteinformationen und Protokollversion werden geprüft …',
    subscribe: 'Benachrichtigungen werden aktiviert …', status: 'Gerätestatus wird abgefragt …',
    ready: 'Verbindung bereit.', closing: 'Verbindung wird beendet …', error: 'Verbindung konnte nicht vollständig beendet werden.',
  })[this.connection.phase()]);
  protected readonly errorText = computed(() => {
    const message = this.connection.error() ?? this.actionError();
    if (!message) return null;
    if (/cleanup/i.test(message)) return 'Die Verbindung konnte nicht sicher beendet werden. Bitte die App vollständig schließen und erneut öffnen.';
    if (/version|capabilit|Info must|UUID/i.test(message)) return 'Dieses Gerät unterstützt das erwartete Lüftlotse-Protokoll v1.0 nicht.';
    if (/timed out|timeout/i.test(message)) return 'Zeitüberschreitung. Das Gerät hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.';
    if (/disconnected/i.test(message)) return 'Die Verbindung zum Gerät wurde unterbrochen.';
    return 'Die Bluetooth-Verbindung ist fehlgeschlagen. Bitte Bluetooth und das Gerät prüfen und erneut versuchen.';
  });
  protected startScan(): void {
    if (!this.busy() && this.connection.state() !== 'ready') void this.scanner.start();
  }
  protected async connect(id: string): Promise<void> {
    if (this.busy() || this.scanner.busy() || !this.scanner.available) return;
    this.pending.set(true); this.actionError.set(null);
    try {
      await this.connection.disconnect();
      await this.connection.connect(id);
    } catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected async disconnect(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true); this.actionError.set(null);
    try { await this.connection.disconnect(); }
    catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected stopScan(): void {
    void this.scanner.stop().catch(() => {}); // Scanner exposes the failure through its state/message.
  }
  protected toggle(): void {
    this.expanded.update(value => !value);
    if (!this.expanded()) this.stopScan();
  }
}
