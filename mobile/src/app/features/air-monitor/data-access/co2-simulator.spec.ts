import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Co2Simulator } from './co2-simulator';
import { co2Status } from '../domain/co2-status';

 describe('Co2Simulator', () => {
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({ providers: [Co2Simulator] }); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('changes smoothly through all demo statuses without duplicate timers', () => {
    const simulator = TestBed.inject(Co2Simulator);
    simulator.start();
    simulator.start();
    expect(vi.getTimerCount()).toBe(1);
    let previous = simulator.current().ppm;
    const colors = new Set<string>();
    for (let second = 0; second < 120; second++) {
      vi.advanceTimersByTime(1000);
      expect(Math.abs(simulator.current().ppm - previous)).toBeLessThanOrEqual(45);
      expect(simulator.current().ppm).toBeGreaterThanOrEqual(650);
      expect(simulator.current().ppm).toBeLessThanOrEqual(2350);
      colors.add(co2Status(simulator.current().ppm).color);
      previous = simulator.current().ppm;
    }
    expect(colors).toEqual(new Set(['green', 'yellow', 'red']));
  });

  it('freezes the reading when stopped and resumes from that reading', () => {
    const simulator = TestBed.inject(Co2Simulator);
    simulator.start();
    vi.advanceTimersByTime(20000);
    simulator.stop();
    const paused = simulator.current().ppm;
    vi.advanceTimersByTime(10000);
    expect(simulator.current().ppm).toBe(paused);
    expect((simulator.state().status === 'running')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    simulator.start();
    vi.advanceTimersByTime(1000);
    expect(simulator.current().ppm).toBeGreaterThan(paused);
  });

  it('clears its timer when the injector is destroyed', () => {
    const simulator = TestBed.inject(Co2Simulator);
    simulator.start();
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
    expect((simulator.state().status === 'running')).toBe(false);
  });
});
