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
    expect(element.querySelector('.badge')?.textContent).toBe('Sensor');
    expect(element.querySelector('.measurement strong')?.textContent).toBe('—');
    expect(element.querySelector('.reading')?.classList.contains('unavailable')).toBe(true);
    expect(element.textContent).toContain('Sensor nicht verfügbar');
    expect(element.querySelector('.source-picker, input[type="radio"], .simulation-toggle, .prototype-warning')).toBeNull();
    expect(element.textContent).not.toMatch(/Simulator|Simulation|Prototyp-Warnung|Demo-Schwellen/);
    expect(element.textContent).toContain('Unter 1000 ppm: akzeptabel.');
    expect(element.textContent).toContain('1000–1999 ppm: bitte lüften.');
    expect(element.textContent).toContain('Ab 2000 ppm: hoher CO₂-Wert, bitte lüften.');
    fixture.destroy();
  });

  it('keeps the normal history source inactive and preserves access to history', async () => {
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
