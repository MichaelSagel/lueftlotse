import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { Co2Simulator } from './co2-simulator';

 describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App] }).compileComponents();
  });

  it('renders the German simulator screen with its initial reading', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toBe('Lüftlotse');
    expect(element.querySelector('.badge')?.textContent).toBe('Simulator');
    expect(element.querySelector('.measurement')?.textContent).toContain('650');
    expect(element.querySelector('.reading')?.classList.contains('green')).toBe(true);
    expect(element.textContent).toContain('Keine medizinische Bewertung');
  });

  it('starts and stops simulation using the button', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    const simulator = TestBed.inject(Co2Simulator);
    button.click();
    fixture.detectChanges();
    expect(simulator.running()).toBe(true);
    expect(button.textContent).toContain('Simulation stoppen');
    button.click();
    fixture.detectChanges();
    expect(simulator.running()).toBe(false);
    expect(button.textContent).toContain('Simulation starten');
  });
});
