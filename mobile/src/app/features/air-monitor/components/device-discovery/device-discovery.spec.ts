import { signal } from '@angular/core';
import { BleJournalSync, JournalResult } from '../../data-access/ble-journal-sync';
import { Co2Storage } from '../../data-access/co2-storage';
import { Co2History } from '../../data-access/co2-history';
import { testStorage } from '../../data-access/co2-storage.testing';
import { routes } from '../../../../app.routes';
import { BleConnection } from '../../data-access/ble-connection';
import { BLE_SESSION } from '../../data-access/ble-session';
import { TestBed } from '@angular/core/testing';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Capacitor } from '@capacitor/core';
import { DeviceDiscovery } from './device-discovery';
import { BleScanner } from '../../data-access/ble-scanner';
import { BleBinding } from '../../data-access/ble-binding-storage';
import { testBleBindingStorage } from '../../data-access/ble-binding.testing';

describe('DeviceDiscovery', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BleScanner, BleConnection, {provide:BLE_SESSION,useExisting:BleConnection}, testBleBindingStorage().provider] });
    TestBed.overrideComponent(DeviceDiscovery,{add:{providers:[{provide:BleJournalSync,useValue:{running:signal(false),savedMeasurements:signal(0),run:vi.fn(),cancel:vi.fn()}}]}});
  });
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
    expect(element.textContent).toContain('Sensor auswählen');
    expect(initialize).not.toHaveBeenCalled();
    expect(element.querySelectorAll('button')).toHaveLength(3);
  });
});

describe('DeviceDiscovery connection UI with a fake session', () => {
  const deviceId = '12345678-1234-4234-8234-123456789abc';
  let calls: string[];
  let journal: {running: ReturnType<typeof signal<boolean>>; savedMeasurements: ReturnType<typeof signal<number>>; run: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>};
  let connection: {state: ReturnType<typeof signal<string>>; phase: ReturnType<typeof signal<string>>;
    info: ReturnType<typeof signal<{deviceId:string}|null>>; error: ReturnType<typeof signal<string|null>>;
    binding: ReturnType<typeof signal<BleBinding|null>>; bindingError: ReturnType<typeof signal<string|null>>;
    bindingLoading: ReturnType<typeof signal<boolean>>;
    connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
    disconnectByUser: ReturnType<typeof vi.fn>; forgetDevice: ReturnType<typeof vi.fn>; attachClient: ReturnType<typeof vi.fn>};
  let scanner: {available: boolean; state: ReturnType<typeof signal<string>>; busy: ReturnType<typeof signal<boolean>>;
    devices: ReturnType<typeof signal<{id:string;name:string;rssi:number}[]>>; message: ReturnType<typeof signal<string>>;
    start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>};
  beforeEach(() => {
    calls=[];
    journal={running:signal(false),savedMeasurements:signal(0),run:vi.fn(async()=>({status:'complete',message:'OK'})),cancel:vi.fn()};
    connection={state:signal('idle'),phase:signal('idle'),info:signal(null),error:signal(null),
      binding:signal(null),bindingError:signal(null),bindingLoading:signal(false),
      connect:vi.fn(async (id:string)=>{calls.push('connect:'+id);connection.info.set({deviceId});connection.state.set('ready');connection.phase.set('ready');}),
      disconnect:vi.fn(async ()=>{calls.push('disconnect');connection.state.set('idle');connection.phase.set('idle');connection.info.set(null);}),
      disconnectByUser:vi.fn(async()=>{await connection.disconnect();const saved=connection.binding();if(saved)connection.binding.set({...saved,connectionEnabled:false});}),
      forgetDevice:vi.fn(async()=>{await connection.disconnect();connection.binding.set(null);}),
      attachClient:vi.fn(()=>({...connection,revoke:vi.fn()})),
    };
    scanner={available:true,state:signal('done'),busy:signal(false),devices:signal([{id:'ble-a',name:'Sensor A',rssi:-55},{id:'ble-b',name:'Sensor B',rssi:-65}]),
      message:signal('Suche beendet.'),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{})};
    TestBed.overrideComponent(DeviceDiscovery,{set:{providers:[{provide:BLE_SESSION,useValue:connection},{provide:BleScanner,useValue:scanner},{provide:BleJournalSync,useValue:journal}]}});
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
    expect(el.textContent).toContain('Sensor verbunden. Die aktuelle Vorschau wird nicht gespeichert.');
    expect(el.textContent).not.toMatch(/Simulator|Simulation|Datenquelle/);
    expect(el.querySelector('.disconnect')?.textContent).toBe('Trennen');
  });
  it('requires an explicit Trennen action before selecting a different device',async()=>{
    connection.state.set('ready');connection.phase.set('ready');connection.info.set({deviceId});
    const {fixture,buttons}=open();buttons()[1].click();await flush();fixture.detectChanges();
    expect(buttons()[1].disabled).toBe(true);expect(calls).toEqual([]);expect(connection.connect).not.toHaveBeenCalled();
  });
  it('keeps a ready connection when collapsed and disconnects only through Trennen',async()=>{
    const {fixture,el,buttons}=open();buttons()[0].click();await flush();fixture.detectChanges();
    connection.disconnect.mockClear();el.querySelector('button')!.click();fixture.detectChanges();
    expect(scanner.stop).toHaveBeenCalledOnce();expect(connection.disconnect).not.toHaveBeenCalled();
    expect(connection.state()).toBe('ready');
    el.querySelector('button')!.click();fixture.detectChanges();
    (el.querySelector('.disconnect') as HTMLButtonElement).click();await flush();fixture.detectChanges();
    expect(connection.disconnect).toHaveBeenCalledOnce();expect(el.querySelector('.device-id')).toBeNull();
    expect(connection.disconnectByUser).toHaveBeenCalledOnce();
  });
  it.each([['Unsupported Info version','Protokoll v1.0'],['STATUS timed out','Zeitüberschreitung'],['BLE cleanup failed','sicher beendet'],
    ['BLE binding UUID mismatch','stimmt nicht mit dem gespeicherten Sensor überein'],
    ['BLE binding storage could not be saved','Gerätebindung oder Verbindungsabsicht'],
    ['BLE migration failed: disk error','Verbindung bleibt gesperrt'], ['BLE permissions: denied','Benachrichtigungen erlauben'],
    ['scan stop uncertain','keine Verbindung gestartet']])('translates %s and handles rejected promises',async(message,text)=>{
    connection.connect.mockRejectedValueOnce(new Error(message));
    const {fixture,el,buttons}=open();buttons()[0].click();await flush();fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(text);
  });
  it('never starts a replacement if prior cleanup fails and shows asynchronous cleanup errors',async()=>{
    connection.state.set('ready');connection.phase.set('ready');
    connection.error.set('BLE cleanup failed');
    const {fixture,el,buttons}=open();buttons()[1].click();await flush();fixture.detectChanges();
    expect(connection.connect).not.toHaveBeenCalled();expect(el.querySelector('[role="alert"]')?.textContent).toContain('sicher beendet');
    connection.error.set('BLE cleanup failed; session cannot be reused');fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('vollständig schließen');
  });
  it('downloads only explicitly after handshake, blocks switching and retains the same run when collapsed',async()=>{
    let finish!: (result:JournalResult)=>void;
    journal.run.mockImplementationOnce(async()=>{journal.running.set(true);const result=await new Promise<JournalResult>(r=>finish=r);journal.running.set(false);return result;});
    const {fixture,el,buttons}=open();expect(el.querySelector('.download')).toBeNull();
    buttons()[0].click();await flush();fixture.detectChanges();expect(journal.run).not.toHaveBeenCalled();
    (el.querySelector('.download') as HTMLButtonElement).click();await flush();fixture.detectChanges();
    expect(journal.run).toHaveBeenCalledOnce();expect(el.textContent).toContain('heruntergeladen');
    expect((el.querySelector('.download') as HTMLButtonElement).disabled).toBe(true);
    expect((el.querySelector('.disconnect') as HTMLButtonElement).disabled).toBe(true);
    expect(buttons().every(b=>b.disabled)).toBe(true);
    buttons()[1].click();expect(connection.connect).toHaveBeenCalledOnce();
    journal.savedMeasurements.set(12);fixture.detectChanges();expect(el.querySelector('.download-count')?.textContent).toContain('12 Messwerte');
    connection.disconnect.mockClear();el.querySelector('button')!.click();fixture.detectChanges();el.querySelector('button')!.click();fixture.detectChanges();
    expect(journal.run).toHaveBeenCalledOnce();expect(journal.cancel).not.toHaveBeenCalled();expect(connection.disconnect).not.toHaveBeenCalled();
    journal.cancel.mockImplementationOnce(()=>finish({status:'cancelled',message:'OK'}));
    (el.querySelector('.cancel-download') as HTMLButtonElement).click();expect(journal.cancel).toHaveBeenCalledOnce();await flush();fixture.detectChanges();
    expect(el.querySelector('.download-result')?.textContent).toContain('abgebrochen');
    expect(el.querySelector('.download-count')?.textContent).toContain('12 Messwerte');expect(el.querySelector('.cancel-download')).toBeNull();
  });
  it.each([
    ['complete','abgeschlossen'],['cancelled','abgebrochen'],['disconnected','verloren'],
    ['time-required','erforderlich'],['busy','beschäftigt'],['error','Fehler'],['clock-invalid','Ungültige'],['unsupported','nicht unterstützt'],
  ] as const)('shows the coordinator result %s',async(status,label)=>{
    connection.state.set('ready');connection.phase.set('ready');journal.run.mockResolvedValueOnce({status,message:'Details'});
    const {fixture,el}=open();(el.querySelector('.download') as HTMLButtonElement).click();await flush();fixture.detectChanges();
    expect(el.querySelector('.download-result')?.textContent).toContain(label);
  });
  it('handles unexpected coordinator rejection without an unhandled promise',async()=>{
    connection.state.set('ready');connection.phase.set('ready');journal.run.mockRejectedValueOnce(new Error('failure'));
    const {fixture,el}=open();(el.querySelector('.download') as HTMLButtonElement).click();await flush();fixture.detectChanges();
    expect(el.querySelector('.download-result')?.textContent).toContain('Fehler');
  });

  it('shows the saved identity/address and connects only when the saved-device button is clicked',async()=>{
    connection.binding.set({version:1,deviceId,bleAddress:'AA:BB:CC:DD:EE:01',connectionEnabled:false});
    const {fixture,el}=open();
    expect(el.querySelector('.saved-device')?.textContent).toContain(deviceId);
    expect(el.querySelector('.saved-device')?.textContent).toContain('AA:BB:CC:DD:EE:01');
    expect(el.textContent).toContain('Manuell getrennt');
    expect(connection.connect).not.toHaveBeenCalled(); expect(scanner.start).not.toHaveBeenCalled();
    (el.querySelector('.connect-saved') as HTMLButtonElement).click(); await flush(); fixture.detectChanges();
    expect(connection.connect).toHaveBeenCalledExactlyOnceWith('AA:BB:CC:DD:EE:01');
    expect(journal.run).not.toHaveBeenCalled();
  });

  it('uses the explicit disconnect/forget actions and can forget while already disconnected',async()=>{
    connection.binding.set({version:1,deviceId,bleAddress:'AA:BB:CC:DD:EE:01',connectionEnabled:true});
    const {fixture,el}=open();
    (el.querySelector('.disconnect') as HTMLButtonElement).click(); await flush(); fixture.detectChanges();
    expect(connection.disconnectByUser).toHaveBeenCalledOnce(); expect(connection.binding()?.connectionEnabled).toBe(false);
    expect(el.querySelector('.forget')).not.toBeNull();
    (el.querySelector('.forget') as HTMLButtonElement).click(); await flush(); fixture.detectChanges();
    expect(connection.forgetDevice).toHaveBeenCalledOnce(); expect(connection.binding()).toBeNull();
    expect(el.querySelector('.saved-device')).toBeNull(); expect(el.querySelector('.forget')).toBeNull();
    expect(connection.connect).not.toHaveBeenCalled(); expect(journal.run).not.toHaveBeenCalled();
  });

  it('keeps forgetting disabled during a journal download and reports a failed removal',async()=>{
    connection.binding.set({version:1,deviceId,bleAddress:'AA:BB:CC:DD:EE:01',connectionEnabled:false});
    const {fixture,el}=open(); journal.running.set(true); fixture.detectChanges();
    const forget=el.querySelector('.forget') as HTMLButtonElement;
    expect(forget.disabled).toBe(true); forget.click(); expect(connection.forgetDevice).not.toHaveBeenCalled();
    journal.running.set(false); connection.forgetDevice.mockRejectedValueOnce(new Error('BLE binding storage could not be removed'));
    fixture.detectChanges(); forget.click(); await flush(); fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Gerätebindung oder Verbindungsabsicht');
    expect(el.querySelector('.saved-device')).not.toBeNull();
  });

});


describe('DeviceDiscovery shared journal DI',()=>{
  it('uses the route connection, scanner and inherited application storage/history',async()=>{
    const store=testStorage();
    TestBed.configureTestingModule({providers:[...routes[0].providers!,store.provider]});
    const fixture=TestBed.createComponent(DeviceDiscovery);
    const injector=fixture.debugElement.injector;
    const journal=injector.get(BleJournalSync) as unknown as {connection:BleConnection;storage:Co2Storage;history:Co2History};
    expect(journal.connection).toBe(injector.get(BLE_SESSION));
    expect(injector.get(BLE_SESSION)).toBe(TestBed.inject(BLE_SESSION));
    expect(TestBed.inject(BleConnection, null)).toBeNull();
    expect(injector.get(BleScanner)).toBe(TestBed.inject(BleScanner));
    expect(injector.get(BleJournalSync)).toBe(TestBed.inject(BleJournalSync));
    expect(journal.storage).toBe(TestBed.inject(Co2Storage));expect(journal.history).toBe(TestBed.inject(Co2History));
    await TestBed.inject(Co2History).whenSettled();fixture.destroy();
  });
});
