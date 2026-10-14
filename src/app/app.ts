import { Component, computed, inject } from '@angular/core';
import { CO2_SOURCE } from './co2-source';
import { co2Status } from './co2-status';
import { Co2Chart } from './co2-chart';

@Component({ selector: 'app-root', imports: [Co2Chart], styleUrl: './app.scss', templateUrl: './app.html' })
export class App {
  protected readonly source = inject(CO2_SOURCE);
  protected readonly status = computed(() => {
    const reading = this.source.current();
    return reading ? co2Status(reading.ppm) : { color: '', label: 'Noch keine Messung', hint: 'Warte auf den ersten CO₂-Wert.' };
  });
  protected toggle(): void {
    if (this.source.state().status === 'running') this.source.stop();
    else this.source.start();
  }
}
