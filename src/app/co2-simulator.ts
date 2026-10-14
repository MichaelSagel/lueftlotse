import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';

export function co2Status(ppm: number) {
  if (ppm < 1000) return { color: 'green', label: 'Niedriger CO₂-Wert', hint: 'Unter der ersten Demo-Schwelle.' };
  if (ppm < 2000) return { color: 'yellow', label: 'Erhöhter CO₂-Wert', hint: 'Zwischen den beiden Demo-Schwellen.' };
  return { color: 'red', label: 'Hoher CO₂-Wert', hint: 'Ab der zweiten Demo-Schwelle.' };
}

@Injectable({ providedIn: 'root' })
export class Co2Simulator {
  private readonly value = signal(650);
  private readonly active = signal(false);
  private timer: ReturnType<typeof setInterval> | undefined;
  private phase = 0;
  readonly ppm = this.value.asReadonly();
  readonly running = this.active.asReadonly();
  readonly status = computed(() => co2Status(this.ppm()));

  constructor() { inject(DestroyRef).onDestroy(() => this.stop()); }

  start(): void {
    if (this.timer !== undefined) return;
    this.active.set(true);
    // Smooth two-minute cycle between 650 and 2350 ppm.
    this.timer = setInterval(() => {
      this.phase += Math.PI / 60;
      this.value.set(Math.round(1500 - 850 * Math.cos(this.phase)));
    }, 1000);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.active.set(false);
  }

  toggle(): void {
    if (this.running()) this.stop();
    else this.start();
  }
}
