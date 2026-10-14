import { CO2_SOURCE } from './co2-source';
import { appConfig } from './app.config';
import { TestBed } from '@angular/core/testing';
import { Co2Chart } from './co2-chart';
import { Co2History } from './co2-history';

describe('Co2Chart', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: appConfig.providers, imports: [Co2Chart] }));

  it('shows guidance for an empty history', () => {
    const fixture = TestBed.createComponent(Co2Chart);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Noch keine Messungen');
    expect(fixture.nativeElement.querySelector('svg')).toBeNull();
  });

  it('renders a single point with ppm and time', () => {
    const history = TestBed.inject(Co2History);
    history.record(650, new Date(2026, 9, 14, 12, 34, 56).getTime());
    const fixture = TestBed.createComponent(Co2Chart);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('circle')).toHaveLength(1);
    expect(element.querySelector('circle')?.getAttribute('cx')).toBe('184');
    expect(element.querySelector('circle title')?.textContent).toBe('12:34:56: 650 ppm');
    expect(element.textContent).toContain('ppm');
    expect(element.querySelector('svg')?.innerHTML).not.toContain('NaN');
  });

  it('renders separate lines across a pause and uses elapsed time for spacing', () => {
    const history = TestBed.inject(Co2History);
    history.beginSegment();
    history.record(650, 0);
    history.record(700, 1000);
    history.beginSegment();
    history.record(750, 10000);
    history.record(800, 11000);
    const fixture = TestBed.createComponent(Co2Chart);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const lines = element.querySelectorAll('polyline');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.getAttribute('points')?.split(' ')).toHaveLength(2);
    const points = element.querySelectorAll('circle');
    const x = Array.from(points, point => Number(point.getAttribute('cx')));
    expect(x[2] - x[1]).toBeGreaterThan((x[1] - x[0]) * 8);
  });
});
