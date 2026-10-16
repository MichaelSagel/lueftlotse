import { signal } from '@angular/core';
import { BleConnection } from '../../data-access/ble-connection';
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

describe('DeviceDiscovery connection UI with a fake session', () => {
  const deviceId = '12345678-1234-4234-8234-123456789abc';
  let calls: string[];
  let connection: {state: ReturnType<typeof signal<string>>; phase: ReturnType<typeof signal<string>>;
    info: ReturnType<typeof signal<{deviceId:string}|null>>; error: ReturnType<typeof signal<string|null>>;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>};
  let scanner: {available: boolean; state: ReturnType<typeof signal<string>>; busy: ReturnType<typeof signal<boolean>>;
    devices: ReturnType<typeof signal<{id:string;name:string;rssi:number}[]>>; message: ReturnType<typeof signal<string>>;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>};
  beforeEach(() => {
    calls=[];
    connection={state:signal('idle'),phase:signal('idle'),info:signal(null),error:signal(null),
      connect:vi.fn(async (id:string)=>{calls.push('connect:'+id);connection.info.set({deviceId});connection.state.set('ready');connection.phase.set('ready');}),
      disconnect:vi.fn(async ()=>{calls.push('disconnect');connection.state.set('idle');connection.phase.set('idle');connection.info.set(null);}),
    };
    scanner={available:true,state:signal('done'),busy:signal(false),devices:signal([{id:'ble-a',name:'Sensor A',rssi:-55},{id:'ble-b',name:'Sensor B',rssi:-65}]),
      message:signal('Suche beendet.'),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{})};
    TestBed.overrideComponent(DeviceDiscovery,{set:{providers:[{provide:BleConnection,useValue:connection},{provide:BleScanner,useValue:scanner}]}});
  });
  const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
  function open() {
    const fixture=TestBed.createComponent(DeviceDiscovery);fixture.detectChanges();
    const el=fixture.nativeElement as HTMLElement;el.querySelector('button')!.click();fixture.detectChanges();
    return {fixture,el,buttons:()=>Array.from(el.querySelectorAll<HTMLButtonElement>('button.connect'))};
  }
  it('shows connection stages, prevents duplicate operations and displays permanent Info identity after STATUS', async()=>{
    let finish!:()=>void;
    connection.connect.mockImplementationOnce(async(id:string)=>{calls.push('connect:'+id);connection.state.set('connecting');connection.phase.set('info');await new Promise<void>(r=>finish=r);connection.state.set('ready');connection.phase.set('ready');connection.info.set({deviceId});});
    const {fixture,el,buttons}=open();buttons()[0].click();await flush();fixture.detectChanges();
    expect(el.querySelector('.connection-status')?.textContent).toContain('Protokollversion');
    for(const button of buttons()) expect(button.disabled).toBe(true);
    const scan=Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='Geräte suchen')!;
    expect(scan.disabled).toBe(true);buttons()[0].click();scan.click();
    expect(connection.connect).toHaveBeenCalledOnce();expect(scanner.start).not.toHaveBeenCalled();
    connection.phase.set('subscribe');fixture.detectChanges();expect(el.textContent).toContain('Benachrichtigungen');
    connection.phase.set('status');fixture.detectChanges();expect(el.textContent).toContain('Gerätestatus');
    expect(el.querySelector('.device-id')).toBeNull();
    finish();await flush();fixture.detectChanges();
    expect(el.querySelector('.device-id')?.textContent).toContain(deviceId);
    expect(el.textContent).toContain('noch keine Sensormesswerte');expect(el.querySelector('.disconnect')?.textContent).toBe('Trennen');
  });
  it('awaits explicit disconnection before connecting to a different device',async()=>{
    connection.state.set('ready');connection.phase.set('ready');connection.info.set({deviceId});
    let finish!:()=>void;connection.disconnect.mockImplementationOnce(async()=>{calls.push('disconnect');await new Promise<void>(r=>finish=r);});
    const {fixture,buttons}=open();buttons()[1].click();await flush();fixture.detectChanges();
    expect(calls).toEqual(['disconnect']);expect(connection.connect).not.toHaveBeenCalled();
    finish();await flush();expect(calls).toEqual(['disconnect','connect:ble-b']);
  });
  it('keeps a ready connection when collapsed and disconnects only through Trennen',async()=>{
    const {fixture,el,buttons}=open();buttons()[0].click();await flush();fixture.detectChanges();
    connection.disconnect.mockClear();el.querySelector('button')!.click();fixture.detectChanges();
    expect(scanner.stop).toHaveBeenCalledOnce();expect(connection.disconnect).not.toHaveBeenCalled();
    expect(connection.state()).toBe('ready');
    el.querySelector('button')!.click();fixture.detectChanges();
    (el.querySelector('.disconnect') as HTMLButtonElement).click();await flush();fixture.detectChanges();
    expect(connection.disconnect).toHaveBeenCalledOnce();expect(el.querySelector('.device-id')).toBeNull();
  });
  it.each([['Unsupported Info version','Protokoll v1.0'],['STATUS timed out','Zeitüberschreitung'],['BLE cleanup failed','sicher beendet']])('translates %s and handles rejected promises',async(message,text)=>{
    connection.connect.mockRejectedValueOnce(new Error(message));
    const {fixture,el,buttons}=open();buttons()[0].click();await flush();fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(text);
  });
  it('never starts a replacement if prior cleanup fails and shows asynchronous cleanup errors',async()=>{
    connection.state.set('ready');connection.phase.set('ready');
    connection.disconnect.mockRejectedValueOnce(new Error('BLE cleanup failed'));
    const {fixture,el,buttons}=open();buttons()[1].click();await flush();fixture.detectChanges();
    expect(connection.connect).not.toHaveBeenCalled();expect(el.querySelector('[role="alert"]')?.textContent).toContain('sicher beendet');
    connection.error.set('BLE cleanup failed; session cannot be reused');fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('vollständig schließen');
  });
});
