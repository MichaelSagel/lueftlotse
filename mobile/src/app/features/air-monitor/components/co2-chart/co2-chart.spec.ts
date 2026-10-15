import { testStorage } from '../../data-access/co2-storage.testing';

import { routes } from '../../../../app.routes';
import { TestBed } from '@angular/core/testing';
import { Co2Chart } from './co2-chart';
import { Co2History } from '../../data-access/co2-history';

describe('Co2Chart', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => { TestBed.configureTestingModule({ providers: [...routes[0].providers!, testStorage().provider], imports: [Co2Chart] }); TestBed.inject(Co2History).setVisible(true); });

  it('shows guidance for an empty history', () => {
    const fixture = TestBed.createComponent(Co2Chart);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Keine Messungen in diesem Zeitraum');
    expect(fixture.nativeElement.querySelector('svg')).toBeNull();
  });

  it('renders a single point with ppm and time', async () => {
    const history = TestBed.inject(Co2History);
    const time = Date.now() - 1000;
    await history.record(650, time);
    await history.refresh();
    const fixture = TestBed.createComponent(Co2Chart);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('circle')).toHaveLength(1);
    expect(element.querySelector('circle')?.getAttribute('cx')).toBe('184');
    expect(element.querySelector('circle title')?.textContent).toContain(': 650 ppm');
    expect(element.textContent).toContain('ppm');
    expect(element.querySelector('svg')?.innerHTML).not.toContain('NaN');
    expect(element.querySelector('svg text[text-anchor="middle"]')?.textContent).toBe(new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time));
    expect(element.querySelector('h3')?.textContent).toBe('Messwerte');
  });

  it('fits the time axis to actual measurements without changing the selected filter', async () => {
    const history = TestBed.inject(Co2History); const now = Date.now();
    const first = now - 21000; const last = now - 1000;
    await history.record(650, first); await history.record(700, now - 11000); await history.record(750, last);
    await history.refresh(); const filter = history.range();
    const fixture = TestBed.createComponent(Co2Chart); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(Array.from(element.querySelectorAll('circle'), circle => Number(circle.getAttribute('cx')))).toEqual([48, 184, 320]);
    const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    expect(element.querySelector('svg text[x="48"][y="174"]')?.textContent).toBe(time.format(first));
    expect(element.querySelector('svg text[x="320"][y="174"]')?.textContent).toBe(time.format(last));
    expect(history.range()).toBe(filter); expect(filter.end - filter.start).toBeGreaterThanOrEqual(300000);
    const svg = element.querySelector('svg'); const circle = element.querySelector('circle');
    const background = history.refresh(true); expect(history.loading()).toBe(false);
    await background; fixture.detectChanges();
    expect(element.querySelector('svg')).toBe(svg); expect(element.querySelector('circle')).toBe(circle);
  });

  it('handles several measurements sharing one timestamp without invalid coordinates', async () => {
    const history = TestBed.inject(Co2History); const time = Date.now() - 1000;
    await history.record(650, time); history.beginSegment(); await history.record(750, time); await history.refresh();
    const fixture = TestBed.createComponent(Co2Chart); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    for (const circle of element.querySelectorAll('circle')) expect(circle.getAttribute('cx')).toBe('184');
    expect(element.querySelectorAll('polyline')).toHaveLength(2);
    expect(element.querySelector('svg')?.innerHTML).not.toMatch(/NaN|Infinity/);
  });

  it('renders separate lines across a pause and uses elapsed time for spacing', async () => {
    const history = TestBed.inject(Co2History);
    history.beginSegment();
    const start = Date.now() - 12000;
    await history.record(650, start);
    await history.record(700, start + 1000);
    history.beginSegment();
    await history.record(750, start + 10000);
    await history.record(800, start + 10500);
    await history.refresh();
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

  it('requires confirmation before deleting the saved history', async () => {
    const history = TestBed.inject(Co2History);
    await history.record(650);
    await history.refresh();
    const fixture = TestBed.createComponent(Co2Chart);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button.delete')!;
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
    button.click();
    await history.whenSettled();
    expect(history.count()).toBe(1);
    expect(confirmation).toHaveBeenCalled();
    confirmation.mockReturnValue(true);
    button.click();
    await history.whenSettled();
    fixture.detectChanges();
    expect(history.count()).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('0 gespeicherte Messungen');
  });

  it('shows storage errors to the user', async () => {
    TestBed.resetTestingModule();
    const store = testStorage();
    store.storage.load.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));
    TestBed.configureTestingModule({ providers: [...routes[0].providers!, store.provider], imports: [Co2Chart] }); TestBed.inject(Co2History).setVisible(true);
    const fixture = TestBed.createComponent(Co2Chart);
    await TestBed.inject(Co2History).whenSettled();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('Speicher voll');
  });

  it('accepts a local custom period, renders its exact table values and rejects normalized invalid dates', async () => {
    const history = TestBed.inject(Co2History);
    await history.record(1234, Date.now() - 3600000);
    await history.whenSettled();
    const fixture = TestBed.createComponent(Co2Chart); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const period = element.querySelector<HTMLSelectElement>('.periods select')!;
    period.value = 'custom'; period.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const inputs = element.querySelectorAll<HTMLInputElement>('input');
    const formatted = (time: number) => {
      const date = new Date(time); const part = (value: number) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
    };
    const start = formatted(Date.now() - 7200000); const end = formatted(Date.now() - 1800000);
    inputs[0].value = start; inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = end; inputs[1].dispatchEvent(new Event('input'));
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await history.whenSettled(); fixture.detectChanges();
    expect(history.range()).toEqual({ start: new Date(start).getTime(), end: new Date(end).getTime() });
    expect(element.querySelector('tbody')?.textContent).toContain('1234');
    expect(element.querySelector('.interval')?.textContent).toContain('Fester Zeitraum');
    inputs[0].value = ''; inputs[0].dispatchEvent(new Event('input'));
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges(); expect(element.querySelector('[role="alert"]')?.textContent).toContain('gültigen Zeitraum');
  });


  it('applies local date drafts only on submit, with inclusive boundaries shared by chart, table and count', async () => {
    const history = TestBed.inject(Co2History);
    const end = new Date(); end.setHours(0,0,0,0); end.setDate(end.getDate()-1);
    const start = new Date(end); start.setDate(start.getDate()-2);
    for (const [offset,ppm] of [[-1,501],[0,601],[1,701]] as const) await history.record(ppm,start.getTime()+offset);
    await history.record(801,end.getTime()); await history.record(901,end.getTime()+1);
    await history.refresh(); await history.whenSettled();
    const fixture = TestBed.createComponent(Co2Chart); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector<HTMLSelectElement>('.periods select')!;
    expect(Array.from(select.options, o=>o.text)).toEqual(['5 Min.','1 Std.','24 Std.','1 Woche','1 Monat','1 Jahr','2 Jahre','Benutzerdefiniert']);
    const before = history.range(); const rows = history.rows();
    select.value='custom'; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    const inputs=el.querySelectorAll<HTMLInputElement>('input');
    const local=(d: Date)=> new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,19);
    inputs[0].value=local(start); inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value=local(end); inputs[1].dispatchEvent(new Event('input'));
    await history.whenSettled(); expect(history.range()).toBe(before); expect(history.rows()).toBe(rows);
    el.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
    await history.whenSettled(); fixture.detectChanges();
    expect(history.range()).toEqual({start:start.getTime(),end:end.getTime()});
    expect(history.tableRange()).toEqual(history.range());
    expect(history.rangeCount()).toBe(3); expect(history.tableCount()).toBe(3);
    expect(history.rows().map(r=>r.ppm)).toEqual([801,701,601]);
    expect(history.measurements().map(r=>r.ppm)).toEqual([601,701,801]);
    expect(el.querySelectorAll('svg tspan')).toHaveLength(2);
    expect(el.textContent).toContain('Ausgewählter Zeitraum'); expect(el.textContent).toContain('Vorhandene Messwerte');
    expect(new Date(history.range().start).toISOString()).toBe(start.toISOString());
  });

  it('renders compact pagination, second precision and an explicit refresh button', async () => {
    const history = TestBed.inject(Co2History); const now = Date.now();
    for (let i = 0; i < 30; i++) await history.record(600 + i, now - (30 - i) * 1000);
    await history.updateTable();
    const fixture = TestBed.createComponent(Co2Chart); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(element.querySelector('tbody tr td:nth-child(2)')?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const toolbar = element.querySelector('.table-toolbar')!;
    expect(toolbar.textContent).toContain('30 Messungen im Zeitraum');
    toolbar.querySelectorAll<HTMLButtonElement>('button')[1].click();
    await history.whenSettled(); fixture.detectChanges();
    expect(toolbar.textContent).toContain('Seite 2');
    const before = element.querySelector('tbody')?.textContent;
    await history.record(900, Date.now()); await history.refresh(); fixture.detectChanges();
    expect(element.querySelector('tbody')?.textContent).toBe(before);
    element.querySelector<HTMLButtonElement>('.new-measurements')!.click();
    await history.whenSettled(); fixture.detectChanges();
    expect(toolbar.textContent).toContain('Seite 1');
    expect(element.querySelector('tbody tr td:last-child')?.textContent).toBe('900');
    const size = element.querySelector<HTMLSelectElement>('.table-toolbar select')!;
    size.value = '25'; size.dispatchEvent(new Event('change'));
    await history.whenSettled(); fixture.detectChanges();
    expect(element.querySelectorAll('tbody tr')).toHaveLength(25);
    expect(history.pageNumber()).toBe(1);
    expect(element.querySelector('.new-measurements')).toBeNull();
  });
});
