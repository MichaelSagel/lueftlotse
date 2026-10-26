import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Info } from '../ble-protocol/codec';
import { BleConnection, PreviewEvent } from './ble-connection';
import { Co2Monitor } from './co2-monitor';
import { Co2Simulator } from './co2-simulator';
import { CO2_SOURCE } from './co2-source';

const uuid = '12345678-1234-4234-8234-123456789abc';
describe('CO2 display source and freshness', () => {
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
      { provide: CO2_SOURCE, useExisting: Co2Simulator },
      { provide: BleConnection, useValue: { ...connection, previewEvents: events.asObservable() } }] });
    monitor = TestBed.inject(Co2Monitor); simulator = TestBed.inject(Co2Simulator);
  });
  afterEach(() => {
    TestBed.resetTestingModule(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
  it('keeps Simulator on BLE connect and requires a fresh sample on every Sensor selection', () => {
    expect(monitor.selected()).toBe('simulator'); monitor.toggleSimulation();
    ready(); sample(); expect(simulator.state().status).toBe('running'); expect(monitor.current()?.ppm).toBe(650);
    monitor.select('sensor'); expect(simulator.state().status).toBe('stopped'); expect(monitor.current()).toBeNull();
    expect(monitor.sensorState()).toBe('waiting'); sample(); expect(monitor.current()?.ppm).toBe(850);
    monitor.toggleSimulation(); expect(simulator.state().status).toBe('stopped');
    monitor.select('simulator'); expect(simulator.state().status).toBe('running');
    sample(999); expect(monitor.current()?.ppm).toBe(650);
    monitor.select('sensor'); expect(monitor.current()).toBeNull(); sample(900); expect(monitor.current()?.ppm).toBe(900);
  });
  it('shows unavailability after exactly 15 seconds, recovers on a new sample, never falls back', async () => {
    ready(); monitor.select('sensor'); await vi.advanceTimersByTimeAsync(14999);
    expect(monitor.sensorState()).toBe('waiting'); await vi.advanceTimersByTimeAsync(1);
    expect(monitor.sensorState()).toBe('stale'); expect(monitor.current()).toBeNull();
    sample(); expect(monitor.sensorState()).toBe('live'); await vi.advanceTimersByTimeAsync(14000);
    sample(900); await vi.advanceTimersByTimeAsync(14999); expect(monitor.current()?.ppm).toBe(900);
    await vi.advanceTimersByTimeAsync(1); expect(monitor.sensorState()).toBe('stale'); expect(monitor.current()).toBeNull();
    expect(monitor.selected()).toBe('sensor'); expect(simulator.state().status).toBe('stopped');
  });
  it('clears immediately on disconnect and starts a new wait after reconnect', async () => {
    monitor.select('sensor'); expect(monitor.sensorState()).toBe('disconnected'); expect(monitor.current()).toBeNull();
    ready(); sample(); await vi.advanceTimersByTimeAsync(10000);
    connection.state.set('error'); events.next({ kind: 'unavailable' });
    expect(monitor.current()).toBeNull(); expect(monitor.sensorState()).toBe('disconnected');
    ready(); expect(monitor.current()).toBeNull(); await vi.advanceTimersByTimeAsync(5000);
    expect(monitor.sensorState()).toBe('waiting'); sample(950); expect(monitor.current()?.ppm).toBe(950);
    expect(monitor.selected()).toBe('sensor');
  });
  it('explains unsupported preview and cancels the deadline when switching to Simulator', async () => {
    monitor.select('sensor'); ready(0); expect(monitor.sensorState()).toBe('unsupported'); expect(vi.getTimerCount()).toBe(0);
    ready(); monitor.select('simulator'); await vi.advanceTimersByTimeAsync(16000);
    expect(monitor.selected()).toBe('simulator'); expect(simulator.state().status).toBe('running');
    monitor.select('sensor'); expect(monitor.sensorState()).toBe('waiting'); expect(monitor.current()).toBeNull();
  });
  it('unsubscribes and clears timers on scope destruction', () => {
    ready(); monitor.select('sensor'); sample(); TestBed.resetTestingModule();
    sample(999); expect(monitor.current()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
});
