import { Injectable, signal } from '@angular/core';

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
  beginSegment(): void { this.segment++; }
  record(ppm: number, time = Date.now()): void {
    this.entries.update(entries => [...entries, { time, ppm, segment: this.segment }].slice(-60));
  }
}
