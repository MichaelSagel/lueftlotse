import { WebBluetoothAdapter } from '../../data-access/web-bluetooth-adapter';
import { Component, DestroyRef, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { BleScanner } from '../../data-access/ble-scanner';
import { BLE_SESSION } from '../../data-access/ble-session';

@Component({
  selector: 'app-device-discovery',
  template: `
    <button type="button" class="connection-action" (click)="connection.state() === 'ready' ? disconnect() : selectSensor()" [disabled]="busy()">
      {{ connection.state() === 'ready' ? 'Trennen' : 'Sensor auswählen' }}
    </button>
    @if (webError() || errorText(); as error) { <p role="alert">{{ error }}</p> }
    @if (scanner.available) {
      <dialog #nativePicker aria-labelledby="sensor-picker-title" (cancel)="$event.preventDefault(); cancelSelection()">
        <h2 id="sensor-picker-title">Sensor auswählen</h2>
        @if (connection.binding(); as saved) {
          <button type="button" class="connect-saved" (click)="connect(saved.bleAddress)" [disabled]="pending() || scanner.busy() || connection.bindingLoading()">Gespeicherten Sensor auswählen</button>
        }
        @if (connection.binding() || connection.bindingError()) {
          <button type="button" class="forget" (click)="forget()" [disabled]="pending()">Gerät vergessen</button>
        }
        <p role="status">{{ scanner.message() }}</p>
        @if (errorText(); as error) { <p role="alert">{{ error }}</p> }
        <ul>
          @for (device of scanner.devices(); track device.id) {
            <li><button type="button" class="connect" (click)="connect(device.id)" [disabled]="pending() || scanner.busy() || connection.bindingLoading()">{{ device.name }}</button></li>
          }
        </ul>
        <button type="button" class="cancel-selection" (click)="cancelSelection()" [disabled]="pending()">Abbrechen</button>
      </dialog>
    }
  `,
  styles: `
    :host { display:block; margin-bottom:24px; }
    button { width:100%; min-height:48px; padding:12px; margin-bottom:8px; border:1px solid #163e2c; border-radius:14px; background:white; color:#163e2c; font:inherit; font-weight:600; cursor:pointer; }
    button:disabled { opacity:.6; cursor:default; }
    button:focus-visible { outline:3px solid #17663e; outline-offset:3px; }
    dialog { width:min(440px, calc(100% - 32px)); max-height:80vh; overflow:auto; padding:16px; border:1px solid #b7cbc1; border-radius:14px; color:#193629; }
    dialog::backdrop { background:#0006; }
    h2 { font-size:18px; }
    ul { list-style:none; padding:0; }
  `,
})
export class DeviceDiscovery {
  protected readonly web = inject(WebBluetoothAdapter, { optional:true });
  protected readonly scanner = inject(BleScanner);
  protected readonly connection = inject(BLE_SESSION);
  private readonly client = this.connection.attachClient();
  private readonly picker = viewChild<ElementRef<HTMLDialogElement>>('nativePicker');
  protected readonly pending = signal(false);
  private readonly selecting = signal(false);
  private readonly actionError = signal<string | null>(null);
  protected readonly webError = computed(() => this.scanner.available ? null : this.web?.error());
  protected readonly busy = computed(() => this.pending() || this.selecting() || this.scanner.busy() || this.connection.bindingLoading() || this.connection.state() === 'connecting' || this.connection.phase() === 'closing');
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.client.revoke();
      if (this.selecting()) void this.scanner.stop().catch(() => {});
    });
  }
  protected async selectSensor(): Promise<void> {
    if (this.busy() || this.connection.state() === 'ready') return;
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
    this.selecting.set(true);
    this.picker()!.nativeElement.showModal();
    try { await this.scanner.start(); }
    catch (error) { this.actionError.set(String(error)); }
  }
  protected async connect(id:string): Promise<void> {
    if (this.pending() || this.scanner.busy() || this.connection.bindingLoading() || this.connection.state() === 'ready') return;
    this.pending.set(true); this.actionError.set(null);
    try {
      await this.scanner.stop();
      await this.client.connect(id);
      this.picker()!.nativeElement.close(); this.selecting.set(false);
    } catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected async cancelSelection(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    try { await this.scanner.stop(); }
    catch (error) { this.actionError.set(String(error)); }
    finally { this.picker()!.nativeElement.close(); this.selecting.set(false); this.pending.set(false); }
  }
  protected async disconnect(): Promise<void> {
    if (this.busy()) return;
    this.pending.set(true); this.actionError.set(null);
    try { await this.client.disconnectByUser(); }
    catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected async forget(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true); this.actionError.set(null);
    try { await this.client.forgetDevice(); }
    catch (error) { this.actionError.set(error instanceof Error ? error.message : String(error)); }
    finally { this.pending.set(false); }
  }
  protected readonly errorText = computed(() => {
    const message = this.connection.bindingError() ?? this.connection.error() ?? this.actionError();
    if (!message) return null;
    if (/migration failed/i.test(message)) return 'Die gespeicherte Gerätebindung konnte nicht übernommen werden. Die Verbindung bleibt gesperrt. Bitte erneut versuchen oder die App erneut öffnen.';
    if (/BLE permissions/i.test(message)) return 'Bitte Bluetooth („Geräte in der Nähe“) und Benachrichtigungen erlauben und die Verbindung in der geöffneten App erneut starten.';
    if (/Suche konnte|Suchstart|scan stop/i.test(message)) return 'Die Suche konnte nicht sicher beendet werden. Es wurde keine Verbindung gestartet. Bitte die Suche stoppen und erneut versuchen.';
    if (/cleanup/i.test(message)) return 'Die Verbindung konnte nicht sicher beendet werden. Bitte die App vollständig schließen und erneut öffnen.';
    if (/binding UUID mismatch|Info UUID mismatch/i.test(message)) return 'Dieses Gerät stimmt nicht mit dem gespeicherten Sensor überein. Die Bindung wurde nicht geändert. Für einen anderen Sensor zuerst „Gerät vergessen“ wählen.';
    if (/binding storage|Bindung|Verbindungsabsicht/i.test(message)) return 'Die Gerätebindung oder Verbindungsabsicht konnte nicht gelesen oder gespeichert werden. Die Verbindung wurde gegebenenfalls geschlossen. Bitte erneut versuchen.';
    if (/version|capabilit|Info must|UUID/i.test(message)) return 'Dieses Gerät unterstützt das erwartete Lüftlotse-Protokoll v1.0/v1.1 nicht.';
    if (/timed out|timeout/i.test(message)) return 'Zeitüberschreitung. Das Gerät hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.';
    if (/disconnected/i.test(message)) return 'Die Verbindung zum Gerät wurde unterbrochen.';
    return 'Die Bluetooth-Verbindung ist fehlgeschlagen. Bitte Bluetooth und das Gerät prüfen und erneut versuchen.';
  });
}
