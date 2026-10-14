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
  it('binds the route token to the existing simulator instance', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), ...routes[0].providers!, testStorage().provider] });
    expect(TestBed.inject(CO2_SOURCE)).toBe(TestBed.inject(Co2Simulator));
  });

  it('allows another source to drive the screen and history without a simulator', async () => {
    const current = signal<Co2Reading | null>(null);
    const state = signal<Co2SourceState>({ status: 'stopped', session: 0 });
    const updates = new Subject<Co2Reading>();
    const source: Co2Source = {
      current: current.asReadonly(), state: state.asReadonly(), readings: updates.asObservable(),
      start: () => state.set({ status: 'running', session: state().session + 1 }),
      stop: () => state.set({ ...state(), status: 'stopped' }),
    };
    TestBed.configureTestingModule({ imports: [AirMonitorPage], providers: [provideRouter([]), testStorage().provider, Co2History, { provide: CO2_SOURCE, useValue: source }] });
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Noch keine Messung');
    const button = element.querySelector('button')!;
    button.click();
    const emit = (ppm: number, time: number) => {
      const reading = { ppm, time: Date.now() - 5000 + time };
      current.set(reading);
      updates.next(reading);
    };
    emit(2100, 1000);
    emit(2200, 2000);
    await TestBed.inject(Co2History).whenSettled(); await TestBed.inject(Co2History).refresh();
    fixture.detectChanges();
    expect(element.querySelector('.measurement')?.textContent).toContain('2200');
    expect(element.querySelector('.reading')?.classList.contains('red')).toBe(true);
    const history = TestBed.inject(Co2History);
    expect(history.measurements()).toHaveLength(2);
    expect(history.measurements()[1]).toMatchObject({ ppm: 2200, time: source.current()!.time });
    button.click();
    emit(2300, 3000);
    expect(history.measurements()).toHaveLength(2);
    button.click();
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
