import { TestBed } from '@angular/core/testing';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
import { DeviceDiscovery } from './device-discovery';
import { BleScanner } from '../../data-access/ble-scanner';

describe('DeviceDiscovery', () => {
  afterEach(() => vi.restoreAllMocks());
  it('is collapsed by default, provides accessible disclosure and stops on collapse', () => {
    const fixture = TestBed.createComponent(DeviceDiscovery);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const button = element.querySelector('button')!;
    const section = element.querySelector('section')!;
    const stop = vi.spyOn(fixture.debugElement.injector.get(BleScanner), 'stop').mockResolvedValue();
    expect(button.getAttribute('aria-controls')).toBe(section.id);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(section.hidden).toBe(true);
    button.click(); fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(section.hidden).toBe(false);
    button.click(); fixture.detectChanges();
    expect(section.hidden).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });
  it('handles stop errors from the stop button and collapse without unhandled rejections', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    const fixture = TestBed.createComponent(DeviceDiscovery);
    const scanner = fixture.debugElement.injector.get(BleScanner);
    const stop = vi.spyOn(scanner, 'stop').mockRejectedValue(new Error('stop failed'));
    scanner.state.set('scanning'); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const disclosure = el.querySelector('button')!;
    disclosure.click(); fixture.detectChanges();
    Array.from(el.querySelectorAll('button')).find(b => b.textContent === 'Suche stoppen')!.click();
    await Promise.resolve();
    disclosure.click(); await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(2);
    stop.mockResolvedValue(); fixture.destroy();
  });

  it('explains Android availability without native calls in the browser', () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('web');
    const initialize = vi.spyOn(BleClient, 'initialize');
    const fixture = TestBed.createComponent(DeviceDiscovery);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    element.querySelector('button')!.click(); fixture.detectChanges();
    expect(element.textContent).toContain('in der Android-App verfügbar');
    expect(initialize).not.toHaveBeenCalled();
    expect(element.querySelectorAll('button')).toHaveLength(1);
  });
});
