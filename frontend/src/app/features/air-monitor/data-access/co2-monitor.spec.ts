import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Info } from '../ble-protocol/codec';
import { BLE_SESSION, PreviewEvent } from './ble-session';
import { Co2Monitor } from './co2-monitor';
import { Co2Simulator } from './co2-simulator';

const uuid = '12345678-1234-4234-8234-123456789abc';
describe('Sensor display and freshness', () => {
  let monitor: Co2Monitor;
  let simulator: Co2Simulator;
  let events: Subject<PreviewEvent>;
  let connection: { state: ReturnType<typeof signal<string>>; info: ReturnType<typeof signal<Info | null>> };
  function ready(capabilities = 16): void {
    connection.info.set({ major: 1, minor: 1, capabilities, deviceId: uuid });
    connection.state.set('ready'); events.next({ kind: 'ready' });
  }
  function sample(ppm = 850): void {
    events.next({ kind: 'sample', sample: { type: 0x8a, bootId: uuid, sampleCounter: 1n, uptimeMs: 5n, ppm } });
  }
  beforeEach(() => {
    vi.useFakeTimers(); events = new Subject();
    connection = { state: signal('idle'), info: signal(null) };
    TestBed.configureTestingModule({ providers: [Co2Monitor, Co2Simulator,
      { provide: BLE_SESSION, useValue: { ...connection, previewEvents: events.asObservable(), attachClient: () => ({ revoke: () => {} }) } }] });
    monitor = TestBed.inject(Co2Monitor); simulator = TestBed.inject(Co2Simulator);
  });
  afterEach(() => {
    TestBed.resetTestingModule(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
  it('starts empty, waits for a new Sensor sample and never starts the simulator', () => {
    const start = vi.spyOn(simulator, 'start');
    expect(monitor.current()).toBeNull(); expect(monitor.sensorState()).toBe('disconnected');
    ready(); expect(monitor.current()).toBeNull(); expect(monitor.sensorState()).toBe('waiting');
    sample(); expect(monitor.current()?.ppm).toBe(850);
    sample(900); expect(monitor.current()?.ppm).toBe(900);
    expect(start).not.toHaveBeenCalled(); expect(simulator.state().status).toBe('stopped');
  });
  it('shows unavailability after exactly 15 seconds, recovers on a new sample, never falls back', async () => {
    ready(); await vi.advanceTimersByTimeAsync(14999);
    expect(monitor.sensorState()).toBe('waiting'); await vi.advanceTimersByTimeAsync(1);
    expect(monitor.sensorState()).toBe('stale'); expect(monitor.current()).toBeNull();
    sample(); expect(monitor.sensorState()).toBe('live'); await vi.advanceTimersByTimeAsync(14000);
    sample(900); await vi.advanceTimersByTimeAsync(14999); expect(monitor.current()?.ppm).toBe(900);
    await vi.advanceTimersByTimeAsync(1); expect(monitor.sensorState()).toBe('stale'); expect(monitor.current()).toBeNull();
    expect(simulator.state().status).toBe('stopped');
  });
  it('clears immediately on disconnect and starts a new wait after reconnect', async () => {
    expect(monitor.sensorState()).toBe('disconnected'); expect(monitor.current()).toBeNull();
    ready(); sample(); await vi.advanceTimersByTimeAsync(10000);
    connection.state.set('error'); events.next({ kind: 'unavailable' });
    expect(monitor.current()).toBeNull(); expect(monitor.sensorState()).toBe('disconnected');
    ready(); expect(monitor.current()).toBeNull(); await vi.advanceTimersByTimeAsync(5000);
    expect(monitor.sensorState()).toBe('waiting'); sample(950); expect(monitor.current()?.ppm).toBe(950);
    expect(simulator.state().status).toBe('stopped');
  });
  it('explains unsupported preview without starting a timer or falling back', async () => {
    ready(0); expect(monitor.sensorState()).toBe('unsupported'); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(16000);
    expect(monitor.current()).toBeNull(); expect(simulator.state().status).toBe('stopped');
    ready(); expect(monitor.sensorState()).toBe('waiting'); expect(monitor.current()).toBeNull();
  });
  it('waits for NEW data even when created after the connection is ready', async () => {
    TestBed.resetTestingModule();
    ready(); sample();
    TestBed.configureTestingModule({ providers: [Co2Monitor,
      { provide: BLE_SESSION, useValue: { ...connection, previewEvents: events.asObservable(), attachClient: () => ({ revoke: () => {} }) } }] });
    monitor = TestBed.inject(Co2Monitor);
    expect(monitor.current()).toBeNull(); expect(monitor.sensorState()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(15000);
    expect(monitor.current()).toBeNull(); expect(monitor.sensorState()).toBe('stale');
    sample(990); expect(monitor.current()?.ppm).toBe(990);
  });
  it('unsubscribes and clears timers on scope destruction', () => {
    ready(); sample(); TestBed.resetTestingModule();
    sample(999); expect(monitor.current()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('expires a resumed sample after its remaining lifetime and rejects an already stale sample', async () => {
    ready(); const value = { type: 0x8a, bootId: uuid, sampleCounter: 1n, uptimeMs: 5n, ppm: 850 } as const;
    events.next({ kind: 'sample', sample: value, ageMs: 14000 }); expect(monitor.current()?.ppm).toBe(850);
    await vi.advanceTimersByTimeAsync(999); expect(monitor.current()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1); expect(monitor.sensorState()).toBe('stale');
    events.next({ kind: 'sample', sample: value, ageMs: 15000 }); expect(monitor.current()).toBeNull();
    events.next({ kind: 'unavailable', reason: 'error' }); expect(monitor.sensorState()).toBe('unavailable');
  });
});
