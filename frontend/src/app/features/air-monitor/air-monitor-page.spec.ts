import { ANDROID_BLE } from './data-access/ble-platform';
import { signal } from '@angular/core';
import { BLE_SESSION } from './data-access/ble-session';
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
    expect(element.querySelector('.badge')).toBeNull();
    expect(element.querySelector('app-synchronization')).toBeNull();
    expect(element.textContent).not.toContain('Synchronisierung');
    expect(element.querySelector('.measurement strong')?.textContent).toBe('—');
    expect(element.querySelector('.measurement span')?.textContent).toBe('ppm');
    expect(element.querySelector('.status')?.textContent).toBe('Sensor nicht verfügbar');
    expect(element.querySelector('.reading')?.classList.contains('unavailable')).toBe(true);
    expect(element.textContent).toContain('Sensor nicht verfügbar');
    expect(element.querySelector('.source-picker, input[type="radio"], .simulation-toggle, .prototype-warning')).toBeNull();
    expect(element.textContent).not.toMatch(/Simulator|Simulation|Prototyp-Warnung|Demo-Schwellen/);
    expect(element.querySelector('footer')).toBeNull();
    fixture.destroy();
  });

  it('shows Android discovery status inside the CO2 card', () => {
    TestBed.overrideComponent(AirMonitorPage, { add: { providers: [{ provide: ANDROID_BLE, useValue: true }] } });
    const session = TestBed.inject(BLE_SESSION);
    const mode = signal<'searching' | null>('searching');
    Object.defineProperty(session, 'discoveryMode', { value: mode });
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.reading .hint')?.textContent).toBe('Sensor wird gesucht …');
    mode.set(null);
    fixture.detectChanges();
    expect(element.querySelector('.reading .hint')?.textContent).not.toBe('Sensor wird gesucht …');
    fixture.destroy();
  });

  it.each([true, false])('pull-to-refresh requests connection only on Android (%s)', async android => {
    TestBed.overrideComponent(AirMonitorPage, { add: { providers: [{ provide: ANDROID_BLE, useValue: android }] } });
    const session = TestBed.inject(BLE_SESSION);
    const originalAttach = session.attachClient.bind(session);
    const refresh = vi.fn(async () => {});
    const attach = vi.spyOn(session, 'attachClient').mockImplementation(() => ({
      ...originalAttach(),
      connectAutomatically: refresh,
    }));
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const main = (fixture.nativeElement as HTMLElement).querySelector('main')!;
    const touch = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchstart' ? [{ clientX: x, clientY: y }] : [] },
        changedTouches: { value: [{ clientX: x, clientY: y }] },
      });
      main.dispatchEvent(event);
    };
    touch('touchstart', 50, 30);
    touch('touchend', 50, 60);
    touch('touchstart', 50, 30);
    touch('touchend', 200, 150);
    touch('touchstart', 50, 30);
    main.dispatchEvent(new Event('touchcancel', { bubbles: true }));
    touch('touchend', 50, 150);
    expect(refresh).not.toHaveBeenCalled();
    touch('touchstart', 50, 30);
    touch('touchend', 50, 150);
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(android ? 1 : 0);
    fixture.destroy();
    attach.mockRestore();
  });

  it('animates Android pull, cancellation and search completion without new controls', async () => {
    TestBed.overrideComponent(AirMonitorPage, { add: { providers: [{ provide: ANDROID_BLE, useValue: true }] } });
    const session = TestBed.inject(BLE_SESSION);
    const state = signal<'idle' | 'connecting' | 'ready'>('idle');
    Object.defineProperty(session, 'state', { value: state });
    const originalAttach = session.attachClient.bind(session);
    const refresh = vi.fn(async () => {
      state.set('connecting');
    });
    const attach = vi.spyOn(session, 'attachClient').mockImplementation(() => ({
      ...originalAttach(),
      connectAutomatically: refresh,
    }));
    const fixture = TestBed.createComponent(AirMonitorPage);
    fixture.detectChanges();
    const main = (fixture.nativeElement as HTMLElement).querySelector('main')!;
    const indicator = main.querySelector<HTMLElement>('.pull-indicator')!;
    const touch = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        touches: { value: type === 'touchend' ? [] : [{ clientX: 50, clientY: y }] },
        changedTouches: { value: [{ clientX: 50, clientY: y }] },
      });
      main.dispatchEvent(event);
      fixture.detectChanges();
    };
    touch('touchstart', 30);
    touch('touchmove', 70);
    expect(indicator.classList.contains('visible')).toBe(true);
    expect(indicator.style.height).toBe('22px');
    main.dispatchEvent(new Event('touchcancel', { bubbles: true }));
    fixture.detectChanges();
    expect(indicator.classList.contains('visible')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    touch('touchstart', 30);
    touch('touchmove', 150);
    touch('touchend', 150);
    await Promise.resolve();
    fixture.detectChanges();
    expect(indicator.querySelector('.spinning')).not.toBeNull();
    expect(indicator.classList.contains('visible')).toBe(true);
    state.set('ready');
    fixture.detectChanges();
    expect(indicator.classList.contains('visible')).toBe(false);
    expect(indicator.querySelector('.spinning')).toBeNull();
    expect(indicator.textContent?.trim()).toBe('');
    expect(indicator.querySelector('button')).toBeNull();
    fixture.destroy();
    attach.mockRestore();
  });

  it('shows only server history in the browser while keeping local storage services', async () => {
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.pull-indicator')).toBeNull();
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

  it.each([false, true])('uses the same simplified page with Android platform flag %s', async android => {
    TestBed.overrideComponent(AirMonitorPage, { add: { providers: [{ provide: ANDROID_BLE, useValue: android }] } });
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.badge, footer, .history-link, #air-monitor-history, app-co2-chart, app-synchronization')).toBeNull();
    expect(element.querySelector<HTMLElement>('#server-history')!.hidden).toBe(false);
    expect(element.querySelector('app-server-history button')!.textContent).toBe('Verlauf anzeigen');
    expect(TestBed.inject(CO2_SOURCE).state().status).toBe('stopped');
    expect(TestBed.inject(Co2Simulator, null)).toBeNull();
    await TestBed.inject(Co2History).whenSettled(); fixture.destroy();
  });
});
