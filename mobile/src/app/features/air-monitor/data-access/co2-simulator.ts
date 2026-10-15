import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { Co2Reading, Co2Source, Co2SourceState } from './co2-source';

@Injectable()
export class Co2Simulator implements Co2Source {
  private readonly value = signal<Co2Reading>({ ppm: 650, time: Date.now() });
  private readonly sourceState = signal<Co2SourceState>({ status: 'stopped', session: 0 });
  private readonly updates = new Subject<Co2Reading>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private phase = 0;
  readonly current = this.value.asReadonly();
  readonly state = this.sourceState.asReadonly();
  readonly readings = this.updates.asObservable();

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.stop(); this.updates.complete(); });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.sourceState.set({ status: 'running', session: this.state().session + 1 });
    // Smooth two-minute cycle between 650 and 2350 ppm.
    this.timer = setInterval(() => {
      this.phase += Math.PI / 60;
      const reading = { ppm: Math.round(1500 - 850 * Math.cos(this.phase)), time: Date.now() };
      this.value.set(reading);
      this.updates.next(reading);
    }, 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.sourceState.set({ ...this.state(), status: 'stopped' });
  }
}
