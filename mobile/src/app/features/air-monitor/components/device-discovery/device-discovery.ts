import { Component, inject, signal } from '@angular/core';
import { BleScanner } from '../../data-access/ble-scanner';

@Component({
  selector: 'app-device-discovery',
  providers: [BleScanner],
  template: `
    <button type="button" (click)="toggle()" [attr.aria-expanded]="expanded()" aria-controls="ble-discovery">Gerät verbinden</button>
    <section id="ble-discovery" [hidden]="!expanded()" aria-label="Bluetooth-Geräte suchen">
      @if (scanner.available) {
        <p>BLE-Geräte in der Nähe suchen. Die Simulation läuft unabhängig weiter.</p>
        <button type="button" (click)="scanner.start()" [disabled]="scanner.busy() || scanner.state() === 'scanning'">Geräte suchen</button>
        @if (scanner.state() === 'scanning') {
          <button type="button" (click)="scanner.stop()">Suche stoppen</button>
        }
        <p role="status">{{ scanner.message() }}</p>
        <ul>
          @for (device of scanner.devices(); track device.id) {
            <li><strong>{{ device.name }}</strong><span>{{ device.id }}</span><span>RSSI: {{ device.rssi ?? '—' }} dBm</span></li>
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
  protected readonly expanded = signal(false);
  protected toggle(): void {
    this.expanded.update(value => !value);
    if (!this.expanded()) void this.scanner.stop();
  }
}
