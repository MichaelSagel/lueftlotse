import { Component, computed, inject, signal } from '@angular/core';
import { CO2_SOURCE } from './data-access/co2-source';
import { co2Status } from './domain/co2-status';
import { Co2Chart } from './components/co2-chart/co2-chart';
import { Co2History } from './data-access/co2-history';
import { DeviceDiscovery } from './components/device-discovery/device-discovery';

@Component({ selector: 'app-air-monitor-page', imports: [Co2Chart, DeviceDiscovery], styleUrl: './air-monitor-page.scss', templateUrl: './air-monitor-page.html' })
export class AirMonitorPage {
  protected readonly source = inject(CO2_SOURCE);
  protected readonly history = inject(Co2History);
  protected readonly historyCreated = signal(false);
  protected toggleHistory(): void {
    this.historyCreated.set(true);
    this.history.setVisible(!this.history.visible());
  }
  protected readonly status = computed(() => {
    const reading = this.source.current();
    return reading ? co2Status(reading.ppm) : { color: '', label: 'Noch keine Messung', hint: 'Warte auf den ersten CO₂-Wert.' };
  });
  protected toggle(): void {
    if (this.source.state().status === 'running') this.source.stop();
    else this.source.start();
  }
}
