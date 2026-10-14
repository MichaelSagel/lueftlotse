import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { CO2_SOURCE } from './co2-source';

export interface Co2Measurement {
  readonly time: number;
  readonly ppm: number;
  readonly segment: number;
}

@Injectable({ providedIn: 'root' })
export class Co2History {
  private readonly entries = signal<readonly Co2Measurement[]>([]);
  private segment = 0;
  readonly measurements = this.entries.asReadonly();
  constructor() {
    const source = inject(CO2_SOURCE);
    const subscription = source.readings.subscribe(reading => {
      if (source.state().status === 'running') {
        this.record(reading.ppm, reading.time, source.state().session);
      }
    });
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe());
  }
  beginSegment(): void { this.segment++; }
  record(ppm: number, time = Date.now(), segment = this.segment): void {
    this.entries.update(entries => [...entries, { time, ppm, segment }].slice(-60));
  }
}
