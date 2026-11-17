import { WebBluetoothAdapter } from '../../data-access/web-bluetooth-adapter';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { BleScanner } from '../../data-access/ble-scanner';
import { BLE_SESSION } from '../../data-access/ble-session';

@Component({
  selector: 'app-device-discovery',
  template: `
    @if (!scanner.available) {
      <button type="button" class="connection-action" (click)="disconnectable() ? disconnect() : selectSensor()" [disabled]="busy()">
        {{ disconnectable() ? 'Trennen' : 'Sensor auswählen' }}
      </button>
    }
    @if (webError() || errorText(); as error) { <p role="alert">{{ error }}</p> }
  `,
  styles: `
    :host { display:block; margin-bottom:24px; }
    :host:empty { display:none; }
    button { width:100%; min-height:48px; padding:12px; margin-bottom:8px; border:1px solid #163e2c; border-radius:14px; background:white; color:#163e2c; font:inherit; font-weight:600; cursor:pointer; }
    button:disabled { opacity:.6; cursor:default; }
    button:focus-visible { outline:3px solid #17663e; outline-offset:3px; }
  `,
})
export class DeviceDiscovery {
  protected readonly web = inject(WebBluetoothAdapter, { optional:true });
  protected readonly scanner = inject(BleScanner);
  protected readonly connection = inject(BLE_SESSION);
  private readonly client = this.connection.attachClient();
  protected readonly pending = signal(false);
  private readonly actionError = signal<string | null>(null);
  protected readonly webError = computed(() => this.scanner.available ? null : this.web?.error());
  protected readonly disconnectable = computed(() => this.connection.state() === 'ready' || this.connection.reconnecting?.() === true
    || (this.scanner.available && this.connection.state() === 'connecting'));
  protected readonly busy = computed(() => this.pending() || this.connection.phase() === 'closing'
    || (!this.disconnectable() && this.connection.bindingLoading())
    || (!this.scanner.available && (this.scanner.busy() || this.connection.bindingLoading() || this.connection.state() === 'connecting')));
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.client.revoke();
    });

  }
  protected async selectSensor(): Promise<void> {
    if (this.busy() || this.disconnectable()) return;
    this.actionError.set(null);
    if (!this.scanner.available) {
      if (!this.web) return;
      const selection = this.web.choose(); // Keep browser requestDevice in the user gesture.
      this.pending.set(true);
      try { const id = await selection; if (id) await this.client.connect(id); }
      catch (error) { this.actionError.set(String(error)); }
      finally { this.pending.set(false); }
      return;
    }
    this.pending.set(true);
    try { await this.client.connectAutomatically?.(); }
    catch (error) { this.actionError.set(String(error)); }
    finally { this.pending.set(false); }
  }
  protected async disconnect(): Promise<void> {
    if (this.busy()) return;
    this.pending.set(true); this.actionError.set(null);
    try { await this.client.disconnectByUser(); }
    catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected readonly errorText = computed(() => {
    const message = this.connection.bindingError() ?? this.connection.error() ?? this.actionError();
    if (!message) return null;
    if (this.scanner.available && /BLE background location/i.test(message)) {
      return 'Bitte auf Android 10/11 in den App-Einstellungen den Standort auf „Immer zulassen“ setzen, damit die Sensor-Suche im Hintergrund funktioniert.';
    }
    if (/migration failed/i.test(message)) return 'Die gespeicherte Gerätebindung konnte nicht übernommen werden. Die Verbindung bleibt gesperrt. Bitte erneut versuchen oder die App erneut öffnen.';
    if (/BLE permissions/i.test(message)) return 'Bitte Bluetooth („Geräte in der Nähe“) und Benachrichtigungen erlauben und die Verbindung in der geöffneten App erneut starten.';
    if (/Suche konnte|Suchstart|scan stop/i.test(message)) return 'Die Suche konnte nicht sicher beendet werden. Es wurde keine Verbindung gestartet. Bitte die Suche stoppen und erneut versuchen.';
    if (/cleanup/i.test(message)) return 'Die Verbindung konnte nicht sicher beendet werden. Bitte die App vollständig schließen und erneut öffnen.';
    if (/binding UUID mismatch|Info UUID mismatch/i.test(message)) return this.scanner.available
      ? 'Dieses Gerät stimmt nicht mit dem gespeicherten Sensor überein. Die Bindung wurde nicht geändert.'
      : 'Dieses Gerät stimmt nicht mit dem gespeicherten Sensor überein. Die Bindung wurde nicht geändert. Für einen anderen Sensor zuerst „Gerät vergessen“ wählen.';
    if (/binding storage|Bindung|Verbindungsabsicht/i.test(message)) return 'Die Gerätebindung oder Verbindungsabsicht konnte nicht gelesen oder gespeichert werden. Die Verbindung wurde gegebenenfalls geschlossen. Bitte erneut versuchen.';
    if (/version|capabilit|Info must|UUID/i.test(message)) return 'Dieses Gerät unterstützt das erwartete Lüftlotse-Protokoll v1.0/v1.1 nicht.';
    if (/timed out|timeout/i.test(message)) return 'Zeitüberschreitung. Das Gerät hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.';
    if (/disconnected/i.test(message)) return 'Die Verbindung zum Gerät wurde unterbrochen.';
    return 'Die Bluetooth-Verbindung ist fehlgeschlagen. Bitte Bluetooth und das Gerät prüfen und erneut versuchen.';
  });
}
