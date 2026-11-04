import { ANDROID_BLE } from './data-access/ble-platform';
import { Component, computed, inject, signal } from '@angular/core';
import { Co2Monitor } from './data-access/co2-monitor';
import { co2Status } from './domain/co2-status';
import { Co2Chart } from './components/co2-chart/co2-chart';
import { Co2History } from './data-access/co2-history';
import { DeviceDiscovery } from './components/device-discovery/device-discovery';
import { Synchronization } from './components/synchronization/synchronization';
import { ServerHistoryBlock } from './components/server-history/server-history';

@Component({ selector: 'app-air-monitor-page', imports: [Co2Chart, DeviceDiscovery, Synchronization, ServerHistoryBlock], styleUrl: './air-monitor-page.scss', templateUrl: './air-monitor-page.html' })
export class AirMonitorPage {
  protected readonly android = inject(ANDROID_BLE);
  protected readonly source = inject(Co2Monitor);
  protected readonly history = inject(Co2History);
  protected readonly historyCreated = signal(false);
  protected toggleHistory(): void {
    this.historyCreated.set(true);
    this.history.setVisible(!this.history.visible());
  }
  protected readonly status = computed(() => {
    const reading = this.source.current();
    if (!reading) return {
      color: 'unavailable',
      label: this.source.sensorState() === 'waiting' ? 'Noch keine Messung' : 'Sensor nicht verfügbar',
      hint: this.source.sensorText(),
    };
    return co2Status(reading.ppm);
  });
}
