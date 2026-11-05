import {
  Component,
  computed,
  inject
} from '@angular/core';
import { Co2Monitor } from './data-access/co2-monitor';
import { co2Status } from './domain/co2-status';
import { Co2History } from './data-access/co2-history';
import { DeviceDiscovery } from './components/device-discovery/device-discovery';
import { ServerHistoryBlock } from './components/server-history/server-history';

@Component({
  selector: 'app-air-monitor-page',
  imports: [DeviceDiscovery, ServerHistoryBlock],
  styleUrl: './air-monitor-page.scss',
  templateUrl: './air-monitor-page.html'
})
export class AirMonitorPage {
  protected readonly source = inject(Co2Monitor);
  // Keep existing local storage initialization/retention while its UI is hidden.
  protected readonly history = inject(Co2History);
  protected readonly status = computed(() => {
    const reading = this.source.current();
    if (!reading) return {
      color: 'unavailable',
      label: this.source.sensorState() === 'waiting'
        ? 'Noch keine Messung'
        : 'Sensor nicht verfügbar',
      hint: this.source.sensorText(),
    };
    return co2Status(reading.ppm);
  });
}
