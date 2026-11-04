import { ANDROID_BLE } from './data-access/ble-platform';
import { provideRouter } from '@angular/router';
import { testStorage } from './data-access/co2-storage.testing';
import { CO2_SOURCE } from './data-access/co2-source';
import { Co2History } from './data-access/co2-history';
import { Co2Simulator } from './data-access/co2-simulator';
import { routes } from '../../app.routes';
import { TestBed } from '@angular/core/testing';
import { AirMonitorPage } from './air-monitor-page';


 describe('AirMonitorPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ providers: [provideRouter([]), ...routes[0].providers!, testStorage().provider], imports: [AirMonitorPage] }).compileComponents();
  });

  it('renders Sensor with no reading, source picker, simulation controls or prototype warning', () => {
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toBe('Lüftlotse');
    expect(element.querySelector('main')!.classList.contains('android')).toBe(false);
    expect(element.querySelector('.badge')).toBeNull();
    expect(element.querySelector('app-synchronization')).toBeNull();
    expect(element.textContent).not.toContain('Synchronisierung');
    expect(element.querySelector('.measurement strong')?.textContent).toBe('—');
    expect(element.querySelector('.reading')?.classList.contains('unavailable')).toBe(true);
    expect(element.textContent).toContain('Sensor nicht verfügbar');
    expect(element.querySelector('.source-picker, input[type="radio"], .simulation-toggle, .prototype-warning')).toBeNull();
    expect(element.textContent).not.toMatch(/Simulator|Simulation|Prototyp-Warnung|Demo-Schwellen/);
    expect(element.querySelector('footer')).toBeNull();
    fixture.destroy();
  });

  it('preserves the badge and manual synchronization in the Android UI', () => {
    TestBed.overrideComponent(AirMonitorPage, { add: { providers: [{ provide: ANDROID_BLE, useValue: true }] } });
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('main')!.classList.contains('android')).toBe(true);
    expect(element.querySelector('.badge')?.textContent).toBe('Sensor');
    expect(element.querySelector('app-synchronization')).not.toBeNull();
    expect(element.querySelector('footer')).not.toBeNull();
    fixture.destroy();
  });

  it('shows only server history in the browser while keeping local storage services', async () => {
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.history-link, #air-monitor-history, app-co2-chart')).toBeNull();
    const button = element.querySelector<HTMLButtonElement>('app-server-history button')!;
    expect(button.textContent).toBe('Verlauf anzeigen');
    expect(Array.from(element.querySelectorAll('button')).filter(b => b.textContent?.trim() === 'Verlauf anzeigen')).toHaveLength(1);
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(element.querySelector<HTMLElement>('#server-history')!.hidden).toBe(false);
    expect(element.querySelectorAll('#server-history input')).toHaveLength(2);
    expect(element.querySelector('app-co2-chart')).toBeNull();
    expect(TestBed.inject(Co2History).visible()).toBe(false);
    expect(TestBed.inject(CO2_SOURCE).state().status).toBe('stopped');
    await TestBed.inject(Co2History).whenSettled(); fixture.destroy();
  });

  it('preserves Android access to local history', async () => {
    TestBed.overrideComponent(AirMonitorPage, { add: { providers: [{ provide: ANDROID_BLE, useValue: true }] } });
    const source = TestBed.inject(CO2_SOURCE);
    const start = vi.spyOn(source, 'start');
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const button = element.querySelector<HTMLButtonElement>('.history-link')!;
    expect(element.querySelector('app-co2-chart')).toBeNull();
    button.click();
    fixture.detectChanges();
    expect(element.querySelector('app-co2-chart')).not.toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(source.state().status).toBe('stopped');
    expect(start).not.toHaveBeenCalled();
    expect(TestBed.inject(Co2Simulator, null)).toBeNull();
    await TestBed.inject(Co2History).whenSettled(); fixture.destroy();
  });
});
