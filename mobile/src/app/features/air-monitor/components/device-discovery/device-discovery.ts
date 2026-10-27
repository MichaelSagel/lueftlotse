import { Component, computed, inject, signal } from '@angular/core';
import { BleScanner } from '../../data-access/ble-scanner';
import { BleConnection } from '../../data-access/ble-connection';
import { BleJournalSync, JournalResult } from '../../data-access/ble-journal-sync';

@Component({
  selector: 'app-device-discovery',
  template: `
    <button type="button" (click)="toggle()" [attr.aria-expanded]="expanded()" aria-controls="ble-discovery">Sensor verbinden</button>
    <section id="ble-discovery" [hidden]="!expanded()" aria-label="Bluetooth-Geräte suchen">
      @if (scanner.available) {
        @if (connection.bindingLoading()) { <p role="status">Gespeichertes Gerät wird geladen …</p> }
        @if (connection.binding(); as saved) {
          <div class="saved-device">
            <p>Gespeicherter Sensor</p>
            <p>Geräte-ID: {{ saved.deviceId }}<br>BLE-Adresse: {{ saved.bleAddress }}</p>
            @if (!saved.connectionEnabled) { <p>Manuell getrennt.</p> }
            <p>Die Verbindung wird mit „Verbinden“ gestartet.</p>
            <button type="button" class="connect-saved" (click)="connect(saved.bleAddress)"
              [disabled]="busy() || scanner.busy() || connection.state() === 'ready'">Verbinden</button>
          </div>
        }
        @if (connection.binding() || connection.bindingError()) {
          <button type="button" class="forget" (click)="forget()" [disabled]="pending() || transferring()">Gerät vergessen</button>
        }
        <p>BLE-Geräte in der Nähe suchen. Die Sensoranzeige wartet auf neue Messwerte.</p>
        <button type="button" (click)="startScan()" [disabled]="busy() || scanner.busy() || scanner.state() === 'scanning' || connection.state() === 'ready'">Geräte suchen</button>
        @if (scanner.state() === 'scanning') {
          <button type="button" (click)="stopScan()">Suche stoppen</button>
        }
        <p role="status">{{ scanner.message() }}</p>
        <p role="status" class="connection-status">{{ phaseText() }}</p>
        @if (connection.state() === 'ready') {
          <p>Sensor verbunden. Die aktuelle Vorschau wird nicht gespeichert.</p>
          <p class="device-id">deviceId: {{ connection.info()?.deviceId }}</p>
          <button type="button" class="download" (click)="download()" [disabled]="busy()">Journalmessungen herunterladen</button>
        }
        @if (transferring()) {
          <p role="status">Messwerte werden heruntergeladen …</p>
          <button type="button" class="cancel-download" (click)="journal.cancel()">Abbrechen</button>
        }
        @if (transferring() || downloadResult()) {
          <p class="download-count" role="status">Bestätigt gespeichert: {{ journal.savedMeasurements() }} Messwerte (einschließlich bereits vorhandener).</p>
        }
        @if (downloadResult(); as result) { <p class="download-result" role="status">{{ resultText() }} {{ result.message }}</p> }
        @if (connection.binding() || connection.state() === 'ready' || busy()) {
          <button type="button" class="disconnect" (click)="disconnect()" [disabled]="pending() || transferring()">Trennen</button>
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
    .saved-device { overflow-wrap: anywhere; }
  `,
})
export class DeviceDiscovery {
  protected readonly scanner = inject(BleScanner);
  protected readonly connection = inject(BleConnection);
  protected readonly journal = inject(BleJournalSync);
  private readonly downloadPending = signal(false);
  protected readonly downloadResult = signal<JournalResult | null>(null);
  protected readonly transferring = computed(() => this.downloadPending() || this.journal.running());
  protected readonly resultText = computed(() => {
    const status = this.downloadResult()?.status;
    return status ? ({complete: 'Übertragung abgeschlossen.', cancelled: 'Übertragung abgebrochen.',
      disconnected: 'Verbindung verloren.', 'time-required': 'Gerätezeit erforderlich.', busy: 'Gerät beschäftigt.',
      'clock-invalid': 'Ungültige Gerätezeit.', unsupported: 'Übertragung nicht unterstützt.', error: 'Fehler bei der Übertragung.'})[status] : '';
  });
  protected readonly expanded = signal(false);
  protected readonly pending = signal(false);
  private readonly actionError = signal<string | null>(null);
  protected readonly busy = computed(() => this.transferring() || this.pending() || this.connection.state() === 'connecting' || this.connection.phase() === 'closing');
  protected readonly phaseText = computed(() => ({
    idle: '', 'scan-stop': 'Suche wird beendet …', initialize: 'Bluetooth wird vorbereitet …',
    connect: 'Verbindung wird hergestellt …', info: 'Geräteinformationen und Protokollversion werden geprüft …',
    subscribe: 'Benachrichtigungen werden aktiviert …', status: 'Gerätestatus wird abgefragt …',
    ready: 'Verbindung bereit.', closing: 'Verbindung wird beendet …', error: 'Verbindung konnte nicht vollständig beendet werden.',
  })[this.connection.phase()]);
  protected readonly errorText = computed(() => {
    const message = this.connection.bindingError() ?? this.connection.error() ?? this.actionError();
    if (!message) return null;
    if (/cleanup/i.test(message)) return 'Die Verbindung konnte nicht sicher beendet werden. Bitte die App vollständig schließen und erneut öffnen.';
    if (/binding UUID mismatch/i.test(message)) return 'Dieses Gerät stimmt nicht mit dem gespeicherten Sensor überein. Die Bindung wurde nicht geändert. Für einen anderen Sensor zuerst „Gerät vergessen“ wählen.';
    if (/binding storage/i.test(message)) return 'Die Gerätebindung konnte nicht gelesen, gespeichert oder gelöscht werden. Bitte erneut versuchen; eine beschädigte Bindung kann mit „Gerät vergessen“ entfernt werden.';
    if (/version|capabilit|Info must|UUID/i.test(message)) return 'Dieses Gerät unterstützt das erwartete Lüftlotse-Protokoll v1.0/v1.1 nicht.';
    if (/timed out|timeout/i.test(message)) return 'Zeitüberschreitung. Das Gerät hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.';
    if (/disconnected/i.test(message)) return 'Die Verbindung zum Gerät wurde unterbrochen.';
    return 'Die Bluetooth-Verbindung ist fehlgeschlagen. Bitte Bluetooth und das Gerät prüfen und erneut versuchen.';
  });
  protected startScan(): void {
    if (!this.busy() && this.connection.state() !== 'ready') void this.scanner.start();
  }
  protected async connect(id: string): Promise<void> {
    if (this.busy() || this.scanner.busy() || !this.scanner.available) return;
    this.pending.set(true); this.actionError.set(null); this.downloadResult.set(null);
    try {
      await this.connection.disconnect();
      await this.connection.connect(id);
    } catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected async disconnect(): Promise<void> {
    if (this.pending() || this.transferring()) return;
    this.pending.set(true); this.actionError.set(null);
    try { await this.connection.disconnectByUser(); }
    catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected async forget(): Promise<void> {
    if (this.pending() || this.transferring()) return;
    this.pending.set(true); this.actionError.set(null);
    try { await this.connection.forgetDevice(); this.downloadResult.set(null); }
    catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected async download(): Promise<void> {
    if (this.busy() || this.connection.state() !== 'ready' || !this.scanner.available) return;
    this.downloadPending.set(true); this.downloadResult.set(null);
    try { this.downloadResult.set(await this.journal.run()); }
    catch { this.downloadResult.set({status:'error',message:'Bitte die Verbindung prüfen und erneut versuchen.'}); }
    finally { this.downloadPending.set(false); }
  }
  protected stopScan(): void {
    void this.scanner.stop().catch(() => {}); // Scanner exposes the failure through its state/message.
  }
  protected toggle(): void {
    this.expanded.update(value => !value);
    if (!this.expanded()) this.stopScan();
  }
}
