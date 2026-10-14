import { CO2_SOURCE } from './co2-source';
import { appConfig } from './app.config';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Co2History } from './co2-history';
import { Co2Simulator } from './co2-simulator';

describe('CO₂ history', () => {
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({ providers: appConfig.providers }); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('retains only the latest 60 measurements with their timestamps', () => {
    const history = TestBed.inject(Co2History);
    expect(history.measurements()).toEqual([]);
    for (let i = 0; i < 65; i++) history.record(650 + i, i * 1000);
    expect(history.measurements()).toHaveLength(60);
    expect(history.measurements()[0]).toMatchObject({ ppm: 655, time: 5000 });
    expect(history.measurements()[59]).toMatchObject({ ppm: 714, time: 64000 });
  });

  it('records only running ticks and preserves history across even a short pause', () => {
    const history = TestBed.inject(Co2History);
    const simulator = TestBed.inject(CO2_SOURCE);
    vi.advanceTimersByTime(3000);
    expect(history.measurements()).toHaveLength(0);
    simulator.start();
    vi.advanceTimersByTime(2000);
    const saved = history.measurements();
    expect(saved).toHaveLength(2);
    expect(saved[1].ppm).toBe(simulator.current()!.ppm);
    expect(saved[1].time - saved[0].time).toBe(1000);
    simulator.stop();
    vi.advanceTimersByTime(100);
    expect(history.measurements()).toBe(saved);
    simulator.start();
    simulator.start();
    vi.advanceTimersByTime(1000);
    expect(history.measurements()).toHaveLength(3);
    expect(history.measurements().slice(0, 2)).toEqual(saved);
    expect(history.measurements()[2].segment).not.toBe(saved[1].segment);
    simulator.stop();
    vi.advanceTimersByTime(10000);
    expect(history.measurements()).toHaveLength(3);
  });
});
