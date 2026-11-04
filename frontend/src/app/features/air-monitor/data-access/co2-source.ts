import { InjectionToken, Signal, signal } from '@angular/core';
import { EMPTY, Observable } from 'rxjs';

export interface Co2Reading {
  readonly time: number;
  readonly ppm: number;
}

export interface Co2SourceState {
  readonly status: 'stopped' | 'running';
  /** Increment on every start/reconnect to mark a break in measurement continuity. */
  readonly session: number;
}

export interface Co2Source {
  readonly current: Signal<Co2Reading | null>;
  readonly state: Signal<Co2SourceState>;
  /** Emit each new measurement once, after updating current and state. */
  readonly readings: Observable<Co2Reading>;
  start(): void;
  stop(): void;
}

export const CO2_SOURCE = new InjectionToken<Co2Source>('CO2_SOURCE');

/** Normal UI reads Sensor preview separately; only tests opt into generated history. */
export function createInactiveCo2Source(): Co2Source {
  return {
    current: signal<Co2Reading | null>(null).asReadonly(),
    state: signal<Co2SourceState>({ status: 'stopped', session: 0 }).asReadonly(),
    readings: EMPTY,
    start: () => {},
    stop: () => {},
  };
}
