import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Co2Simulator, co2Status } from './co2-simulator';

 describe('Co2Simulator', () => {
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({}); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it.each([[999, 'green'], [1000, 'yellow'], [1999, 'yellow'], [2000, 'red']])(
    'classifies %i ppm as %s', (ppm, color) => {
      expect(co2Status(Number(ppm)).color).toBe(color);
    },
  );

  it('changes smoothly through all demo statuses without duplicate timers', () => {
    const simulator = TestBed.inject(Co2Simulator);
    simulator.start();
    simulator.start();
    expect(vi.getTimerCount()).toBe(1);
    let previous = simulator.ppm();
    const colors = new Set<string>();
    for (let second = 0; second < 120; second++) {
      vi.advanceTimersByTime(1000);
      expect(Math.abs(simulator.ppm() - previous)).toBeLessThanOrEqual(45);
      expect(simulator.ppm()).toBeGreaterThanOrEqual(650);
      expect(simulator.ppm()).toBeLessThanOrEqual(2350);
      colors.add(simulator.status().color);
      previous = simulator.ppm();
    }
    expect(colors).toEqual(new Set(['green', 'yellow', 'red']));
  });

  it('freezes the reading when stopped and resumes from that reading', () => {
    const simulator = TestBed.inject(Co2Simulator);
    simulator.start();
    vi.advanceTimersByTime(20000);
    simulator.stop();
    const paused = simulator.ppm();
    vi.advanceTimersByTime(10000);
    expect(simulator.ppm()).toBe(paused);
    expect(simulator.running()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    simulator.start();
    vi.advanceTimersByTime(1000);
    expect(simulator.ppm()).toBeGreaterThan(paused);
  });

  it('clears its timer when the injector is destroyed', () => {
    const simulator = TestBed.inject(Co2Simulator);
    simulator.start();
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
    expect(simulator.running()).toBe(false);
  });
});
