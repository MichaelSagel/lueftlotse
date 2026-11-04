import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { By } from '@angular/platform-browser';
import { Synchronization } from './synchronization';
import { testStorage } from '../../data-access/co2-storage.testing';
import { Co2Sync } from '../../data-access/co2-sync';

describe('Synchronization disclosure', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  it('is collapsed by default and updates counts only while visible without starting a transfer', async () => {
    const store = testStorage([{ time: 1000, ppm: 850, segment: 'one' }]);
    TestBed.configureTestingModule({ imports: [Synchronization], providers: [store.provider] });
    const fixture = TestBed.createComponent(Synchronization); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const toggle = element.querySelector('button')!; const section = element.querySelector('section')!;
    const sync = fixture.debugElement.injector.get(Co2Sync);
    const transfer = vi.spyOn(sync, 'synchronize');
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(section.hidden).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(section.id);
    expect(store.storage.syncSnapshot).not.toHaveBeenCalled();
    toggle.click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(section.hidden).toBe(false); expect(element.textContent).toContain('pending): 1');
    expect(transfer).not.toHaveBeenCalled();
    store.storage.syncSnapshot.mockResolvedValue({ pending: 2, synced: 0, maxKey: 2 });
    store.storage.changes.update(value => value + 1);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(element.textContent).toContain('pending): 2');
    toggle.click(); fixture.detectChanges(); const calls = store.storage.syncSnapshot.mock.calls.length;
    store.storage.changes.update(value => value + 1); fixture.detectChanges(); await fixture.whenStable();
    expect(store.storage.syncSnapshot).toHaveBeenCalledTimes(calls);
  });
  it('shows the Android server configuration message and disables manual sync', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    TestBed.configureTestingModule({ imports: [Synchronization], providers: [testStorage().provider] });
    const fixture = TestBed.createComponent(Synchronization); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    element.querySelector('button')!.click(); fixture.detectChanges();
    expect(element.textContent).toContain('Server noch nicht eingerichtet');
    expect(element.querySelectorAll('button')[1].disabled).toBe(true);
    expect(fixture.debugElement.query(By.css('progress'))).toBeNull();
  });
});
