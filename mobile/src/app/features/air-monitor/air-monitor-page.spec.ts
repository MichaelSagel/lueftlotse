import { provideRouter } from '@angular/router';
import { testStorage } from './data-access/co2-storage.testing';
import { CO2_SOURCE } from './data-access/co2-source';
import { routes } from '../../app.routes';
import { TestBed } from '@angular/core/testing';
import { AirMonitorPage } from './air-monitor-page';


 describe('AirMonitorPage', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ providers: [provideRouter([]), ...routes[0].providers!, testStorage().provider], imports: [AirMonitorPage] }).compileComponents();
  });

  it('renders the German simulator screen with its initial reading', () => {
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toBe('Lüftlotse');
    expect(element.querySelector('.badge')?.textContent).toBe('Simulator');
    expect(element.querySelector('.measurement')?.textContent).toContain('650');
    expect(element.querySelector('.reading')?.classList.contains('green')).toBe(true);
    expect(element.textContent).toContain('Keine medizinische Bewertung');
  });

  it('starts and stops simulation using the button', () => {
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    const simulator = TestBed.inject(CO2_SOURCE);
    button.click();
    fixture.detectChanges();
    expect((simulator.state().status === 'running')).toBe(true);
    expect(button.textContent).toContain('Simulation stoppen');
    button.click();
    fixture.detectChanges();
    expect((simulator.state().status === 'running')).toBe(false);
    expect(button.textContent).toContain('Simulation starten');
  });
});
