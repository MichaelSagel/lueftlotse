import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DeviceDiscovery } from './device-discovery';
import { BLE_SESSION } from '../../data-access/ble-session';
import { WebBluetoothAdapter } from '../../data-access/web-bluetooth-adapter';
import { BleScanner } from '../../data-access/ble-scanner';
import { BleJournalSync } from '../../data-access/ble-journal-sync';
import { BleConnection } from '../../data-access/ble-connection';
import { Co2Storage } from '../../data-access/co2-storage';
import { Co2History } from '../../data-access/co2-history';
import { testStorage } from '../../data-access/co2-storage.testing';
import { routes } from '../../../../app.routes';

const flush = async () => { for(let i=0;i<16;i++) await Promise.resolve(); };
describe('native automatic sensor UI', () => {
  let connection: ReturnType<typeof createSession>;
  const scanner = { available: true, busy: signal(false), start: vi.fn(), stop: vi.fn() };
  function createSession() {
    return {
      state: signal('idle'), phase: signal('idle'), reconnecting: signal(false),
      discoveryMode: signal<'searching' | 'connecting' | 'choice' | null>(null),
      candidates: signal<{ address: string; name: string }[]>([]),
      bindingLoading: signal(false), binding: signal<object | null>(null),
      bindingError: signal<string | null>(null), error: signal<string | null>(null),
      attachClient: vi.fn(), revoke: vi.fn(), connect: vi.fn(),
      connectAutomatically: vi.fn(async () => {
        connection.state.set('connecting');
        connection.discoveryMode.set('searching');
      }),
      selectSensor: vi.fn(async (_address: string) => {
        connection.discoveryMode.set('connecting');
      }),
      disconnectByUser: vi.fn(async () => {
        connection.state.set('idle');
        connection.discoveryMode.set(null);
      }),
      forgetDevice: vi.fn(async () => { connection.binding.set(null); }),
    };
  }
  beforeEach(() => {
    connection = createSession();
    connection.attachClient.mockReturnValue(connection);
    scanner.start.mockClear();
    TestBed.configureTestingModule({ providers: [
      { provide: BLE_SESSION, useValue: connection },
      { provide: BleScanner, useValue: scanner },
      { provide: WebBluetoothAdapter, useValue: null },
    ] });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true, value: function(this: HTMLDialogElement) { this.open = true; },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true, value: function(this: HTMLDialogElement) { this.open = false; },
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });
  function render() {
    const fixture = TestBed.createComponent(DeviceDiscovery);
    fixture.detectChanges();
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }
  it.each(['idle', 'connecting', 'ready', 'closing', 'error'])('has no Android connection controls in state %s', state => {
    connection.state.set(state);
    const { element } = render();
    expect(element.querySelector('button, dialog, li')).toBeNull();
    expect(connection.disconnectByUser).not.toHaveBeenCalled();
    expect(connection.connectAutomatically).not.toHaveBeenCalled();
  });
  it('has no controls while native discovery or reconnect is active', () => {
    connection.state.set('connecting');
    connection.discoveryMode.set('searching');
    connection.reconnecting.set(true);
    const { element } = render();
    expect(element.querySelector('button, dialog, li')).toBeNull();
    expect(scanner.start).not.toHaveBeenCalled();
  });
  it('never exposes a native device list or forget action', () => {
    connection.binding.set({ deviceId: 'saved' });
    connection.discoveryMode.set('choice');
    connection.candidates.set([{ address: 'A', name: 'A' }, { address: 'B', name: 'B' }]);
    const { element } = render();
    expect(element.querySelector('dialog, ul, .forget, .connect')).toBeNull();
    expect(connection.selectSensor).not.toHaveBeenCalled();
    expect(connection.forgetDevice).not.toHaveBeenCalled();
  });
  it('explains legacyBackgroundLocation using the Android settings instruction', () => {
    connection.error.set('BLE background location: Standort immer zulassen');
    const { element } = render();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Immer zulassen');
  });

});
describe.each([false])('shared connection UI, native scanner=%s', native => {
  const saved = {version:1,deviceId:'00112233-4455-4677-8899-aabbccddeeff',bleAddress:'address',connectionEnabled:true};
  let connection: ReturnType<typeof session>;
  let scanner: {available:boolean;busy:ReturnType<typeof signal<boolean>>;devices:ReturnType<typeof signal<{id:string;name:string}[]>>;start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;message:()=>string};
  let web: { choose:ReturnType<typeof vi.fn>;error:ReturnType<typeof signal<string|null>> };
  function session() {
    return { state:signal('idle'), phase:signal('idle'),bindingLoading:signal(false),binding:signal<typeof saved|null>(null),bindingError:signal<string|null>(null),error:signal<string|null>(null),
      connect:vi.fn(async (_id:string)=>{}),disconnectByUser:vi.fn(async()=>{}),forgetDevice:vi.fn(async()=>{}),revoke:vi.fn(),attachClient:vi.fn() };
  }
  beforeEach(() => {
    connection=session();connection.attachClient.mockReturnValue(connection);
    connection.connect.mockImplementation(async()=>{connection.state.set('ready');connection.phase.set('ready');});
    connection.disconnectByUser.mockImplementation(async()=>{connection.state.set('idle');connection.phase.set('idle');});
    connection.forgetDevice.mockImplementation(async()=>{connection.binding.set(null);});
    scanner={available:native,busy:signal(false),devices:signal([{id:'address',name:'Sensor A'}]),start:vi.fn(async()=>{}),stop:vi.fn(async()=>{}),message:()=>''};
    web={choose:vi.fn(async()=> 'address'),error:signal<string|null>(null)};
    TestBed.configureTestingModule({providers:[{provide:BLE_SESSION,useValue:connection},{provide:BleScanner,useValue:scanner},{provide:WebBluetoothAdapter,useValue:web}]});
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable:true, value:function(this:HTMLDialogElement){this.open=true;} });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable:true, value:function(this:HTMLDialogElement){this.open=false;} });
  });
  afterEach(()=>{TestBed.resetTestingModule();vi.restoreAllMocks();Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');Reflect.deleteProperty(HTMLDialogElement.prototype,'close');});
  function render(){const fixture=TestBed.createComponent(DeviceDiscovery);fixture.detectChanges();const el=fixture.nativeElement as HTMLElement;return {fixture,el,button:el.querySelector<HTMLButtonElement>('.connection-action')!};}
  async function choose(el:HTMLElement,button:HTMLButtonElement){button.click();await flush();if(native){(el.querySelector('.connect') as HTMLButtonElement).click();await flush();}}
  it('has the same single permanent button and uses the selected platform for device choice',async()=>{
    const {fixture,el,button}=render();
    expect(button.textContent?.trim()).toBe('Sensor auswählen');expect(el.querySelectorAll(':scope > button')).toHaveLength(1);
    expect(el.querySelector('section')).toBeNull();expect(el.textContent).not.toContain('Sensor verbinden');
    expect(connection.connect).not.toHaveBeenCalled();
    await choose(el,button);fixture.detectChanges();
    expect(connection.connect).toHaveBeenCalledExactlyOnceWith('address');
    expect(button.textContent?.trim()).toBe('Trennen');
    if(native){expect(scanner.start).toHaveBeenCalledOnce();expect(scanner.stop).toHaveBeenCalledOnce();expect(web.choose).not.toHaveBeenCalled();expect(el.querySelector('dialog')!.open).toBe(false);}
    else {expect(web.choose).toHaveBeenCalledOnce();expect(scanner.start).not.toHaveBeenCalled();}
    button.click();await flush();fixture.detectChanges();expect(connection.disconnectByUser).toHaveBeenCalledOnce();expect(button.textContent?.trim()).toBe('Sensor auswählen');
    fixture.destroy();expect(connection.revoke).toHaveBeenCalledOnce();
  });
  if (native) {
    it('keeps Trennen enabled during native reconnect and cancels via the existing user action', async () => {
      const reconnecting = signal(true);
      Object.assign(connection, { reconnecting });
      connection.state.set('connecting');
      const { fixture, button } = render();
      expect(button.textContent?.trim()).toBe('Trennen');
      expect(button.disabled).toBe(false);
      button.click();
      await flush();
      expect(connection.disconnectByUser).toHaveBeenCalledOnce();
      expect(connection.connect).not.toHaveBeenCalled();
      expect(scanner.start).not.toHaveBeenCalled();
      fixture.destroy();
    });
  }
  it('blocks duplicate clicks while selecting, connecting and disconnecting',async()=>{
    let finish!:()=>void;
    connection.connect.mockImplementationOnce(async()=>{connection.state.set('connecting');await new Promise<void>(r=>finish=r);connection.state.set('ready');});
    const {fixture,el,button}=render();button.click();await flush();fixture.detectChanges();
    expect(button.disabled).toBe(true);button.click();
    if(native){expect(scanner.start).toHaveBeenCalledOnce();(el.querySelector('.connect') as HTMLButtonElement).click();await flush();}
    else expect(web.choose).toHaveBeenCalledOnce();
    fixture.detectChanges();expect(button.disabled).toBe(true);expect(connection.connect).toHaveBeenCalledOnce();
    finish();await flush();fixture.detectChanges();expect(button.disabled).toBe(false);
    connection.disconnectByUser.mockImplementationOnce(()=>new Promise<void>(r=>finish=r));
    button.click();fixture.detectChanges();expect(button.disabled).toBe(true);button.click();expect(connection.disconnectByUser).toHaveBeenCalledOnce();finish();await flush();fixture.destroy();
  });
  it('preserves errors and does not show ordinary ready messages',async()=>{
    const {fixture,el}=render();connection.state.set('ready');connection.phase.set('ready');connection.error.set('BLE cleanup failed');fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('sicher beendet');expect(el.textContent).not.toContain('Verbindung bereit.');fixture.destroy();
  });
  it('preserves browser button locking while a binding read is pending', () => {
    connection.state.set('ready');
    connection.phase.set('ready');
    connection.bindingLoading.set(true);
    const { fixture, button } = render();
    expect(button.textContent?.trim()).toBe('Trennen');
    expect(button.disabled).toBe(true);
    fixture.destroy();
  });
  if(native){
    it('cancels the selector safely and forgets a saved binding only explicitly',async()=>{
      connection.binding.set(saved);const {fixture,el,button}=render();button.click();await flush();fixture.detectChanges();
      expect(connection.forgetDevice).not.toHaveBeenCalled();(el.querySelector('.forget') as HTMLButtonElement).click();await flush();fixture.detectChanges();
      expect(connection.forgetDevice).toHaveBeenCalledOnce();expect(connection.connect).not.toHaveBeenCalled();
      (el.querySelector('.cancel-selection') as HTMLButtonElement).click();await flush();fixture.detectChanges();
      expect(scanner.stop).toHaveBeenCalledOnce();expect(el.querySelector('dialog')!.open).toBe(false);expect(button.disabled).toBe(false);fixture.destroy();
    });
    it('does not connect when scanner cleanup fails',async()=>{
      scanner.stop.mockRejectedValue(new Error('scan stop uncertain'));const {fixture,el,button}=render();await choose(el,button);fixture.detectChanges();
      expect(connection.connect).not.toHaveBeenCalled();expect(el.querySelector('[role="alert"]')?.textContent).toContain('keine Verbindung gestartet');fixture.destroy();
    });
  }
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
