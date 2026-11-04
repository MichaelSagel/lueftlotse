import { provideRouter } from '@angular/router';
import { testStorage } from './co2-storage.testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { AirMonitorPage } from '../air-monitor-page';
import { routes } from '../../../app.routes';
import { Co2History } from './co2-history';
import { Co2Simulator } from './co2-simulator';
import { CO2_SOURCE, Co2Reading, Co2Source, Co2SourceState } from './co2-source';

describe('CO2 source DI', () => {
  it('provides an inactive history source without registering the simulator in the normal route', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), ...routes[0].providers!, testStorage().provider] });
    const source = TestBed.inject(CO2_SOURCE);
    expect(TestBed.inject(Co2Simulator, null)).toBeNull();
    expect(source.current()).toBeNull(); expect(source.state().status).toBe('stopped');
  });

  it('allows an explicit test source to drive history independently of the Sensor screen', async () => {
    const current = signal<Co2Reading | null>(null);
    const state = signal<Co2SourceState>({ status: 'stopped', session: 0 });
    const updates = new Subject<Co2Reading>();
    const source: Co2Source = {
      current: current.asReadonly(), state: state.asReadonly(), readings: updates.asObservable(),
      start: () => state.set({ status: 'running', session: state().session + 1 }),
      stop: () => state.set({ ...state(), status: 'stopped' }),
    };
    TestBed.configureTestingModule({ imports: [AirMonitorPage], providers: [provideRouter([]), ...routes[0].providers!, testStorage().provider, { provide: CO2_SOURCE, useValue: source }] });
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Sensor nicht verfügbar');
    expect(state().status).toBe('stopped');
    source.start();
    const emit = (ppm: number, time: number) => {
      const reading = { ppm, time: Date.now() - 5000 + time };
      current.set(reading);
      updates.next(reading);
    };
    emit(2100, 1000);
    emit(2200, 2000);
    await TestBed.inject(Co2History).whenSettled(); await TestBed.inject(Co2History).refresh();
    fixture.detectChanges();
    expect(element.querySelector('.measurement strong')?.textContent).toBe('—');
    expect(element.querySelector('.reading')?.classList.contains('unavailable')).toBe(true);
    const history = TestBed.inject(Co2History);
    expect(history.measurements()).toHaveLength(2);
    expect(history.measurements()[1]).toMatchObject({ ppm: 2200, time: source.current()!.time });
    source.stop();
    emit(2300, 3000);
    expect(history.measurements()).toHaveLength(2);
    source.start();
    emit(2400, 4000);
    await history.whenSettled(); await history.refresh();
    fixture.detectChanges();
    expect(history.measurements()).toHaveLength(3);
    expect(element.querySelector('app-co2-chart')).toBeNull();
    fixture.destroy();
    TestBed.resetTestingModule();
    emit(2500, 5000);
    await history.whenSettled(); await history.refresh();
    expect(history.measurements()).toHaveLength(3);
  });
});
