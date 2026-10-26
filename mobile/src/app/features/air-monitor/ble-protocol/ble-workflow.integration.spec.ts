import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { BleClient, ScanResult } from '@capacitor-community/bluetooth-le';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { routes } from '../../../app.routes';
import { AirMonitorPage } from '../air-monitor-page';
import { DeviceDiscovery } from '../components/device-discovery/device-discovery';
import { By } from '@angular/platform-browser';
import { BLE_ADAPTER, BleAdapter } from '../data-access/ble-adapter';
import { BleConnection } from '../data-access/ble-connection';
import { BleJournalSync } from '../data-access/ble-journal-sync';
import { BleScanner } from '../data-access/ble-scanner';
import { Co2Storage } from '../data-access/co2-storage';
import { Co2History } from '../data-access/co2-history';
import { Co2Simulator } from '../data-access/co2-simulator';
import { CO2_SOURCE } from '../data-access/co2-source';
import { batchDigest, encodeInfo, Message, ReadyEntry } from './codec';
import { fragmentMessage, FragmentAssembler } from './fragments';

const deviceId = '00112233-4455-4677-8899-aabbccddeeff';
const address = 'native-ble-identifier';
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The only fake application boundary: scan and GATT operations of a peripheral. */
class Peripheral implements BleAdapter {
  readonly log: string[] = [];
  readonly records: ReadyEntry[] = [];
  readonly fetches: bigint[] = [];
  readonly acknowledged: bigint[] = [];
  private readonly control = new FragmentAssembler('control');
  private eventId = 0;
  private sampleCounter = 0n;
  private notify?: (value: DataView) => void;
  subscriptions = 0;
  available(): boolean { return true; }
  async initialize(): Promise<void> { this.log.push('initialize'); }
  async connect(id: string): Promise<void> {
    expect(id).toBe(address); this.log.push('connect'); this.control.reset(); this.eventId = 0;
  }
  async readInfo(): Promise<DataView> { this.log.push('info'); return view(encodeInfo(deviceId, 31, 1)); }
  async subscribe(_: string, callback: (value: DataView) => void): Promise<void> {
    this.log.push('subscribe'); this.notify = callback; this.subscriptions++;
  }
  async unsubscribe(): Promise<void> { this.log.push('unsubscribe'); this.notify = undefined; this.subscriptions--; }
  async disconnect(): Promise<void> { this.log.push('disconnect'); this.control.dispose(); }
  add(): void {
    const sequence = BigInt(this.records.length + 1);
    this.records.push({tag:1,sequence,measurementId:crypto.randomUUID(),bootId:deviceId,segmentId:deviceId,
      uptimeMs:sequence*5000n,utcMs:BigInt(Date.now()-30000)+sequence*1000n,ppm:901+this.records.length});
  }
  private emit(message: Message): void {
    for (const frame of fragmentMessage(message,this.eventId++,'events')) this.notify!(view(frame));
  }
  async write(_: string, value: DataView): Promise<void> {
    const decoded = this.control.push(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));
    if (!decoded) return;
    const {message,messageId} = decoded;
    if (message.type === 1) {
      this.log.push('status');
      this.emit({type:0x80,requestId:messageId,bootId:deviceId,oldest:1n,latest:BigInt(this.records.length),
        overwrittenThrough:0n,timeValid:1,firstUndated:0n,storageState:0});
    } else if (message.type === 3) {
      this.fetches.push(message.afterSequence); this.log.push('fetch');
      const entries = this.records.filter(entry=>entry.sequence>message.afterSequence).slice(0,Math.min(message.limit,2));
      expect(entries.length).toBeGreaterThan(0);
      const begin = {type:0x82,requestId:messageId,batchId:crypto.randomUUID(),afterSequence:message.afterSequence,
        throughSequence:entries.at(-1)!.sequence,count:entries.length} as const;
      const digest = await batchDigest(begin,entries);
      // Complete notifications arrive during write, before its Promise resolves.
      this.emit(begin);
      this.emit({type:0x8a,bootId:deviceId,sampleCounter:++this.sampleCounter,uptimeMs:this.sampleCounter*5000n,ppm:1234});
      for(const entry of entries) this.emit({type:0x83,batchId:begin.batchId,entry});
      this.emit({type:0x84,batchId:begin.batchId,digest});
    } else if (message.type === 4) {
      this.acknowledged.push(message.throughSequence); this.log.push('ack');
      this.emit({type:0x87,requestId:messageId,batchId:message.batchId});
    } else throw new Error('Unexpected command: no TIME_SET or other operations allowed');
  }
}

describe('Manual BLE discovery-to-persistent-history workflow',()=>{
  afterEach(()=>{ TestBed.resetTestingModule(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('discovers, handshakes, manually imports two batches and resumes without duplicates while the simulator remains active',async()=>{
    vi.stubGlobal('indexedDB',new IDBFactory()); vi.stubGlobal('IDBKeyRange',IDBKeyRange);
    // Freeze simulator ticks only; IndexedDB scheduling and BLE timeouts remain native.
    vi.useFakeTimers({toFake:['setInterval','clearInterval','Date']});
    const peripheral = new Peripheral(); for(let i=0;i<4;i++) peripheral.add();
    vi.spyOn(Capacitor,'getPlatform').mockReturnValue('android');
    vi.spyOn(BleClient,'initialize').mockImplementation(()=>peripheral.initialize());
    vi.spyOn(BleClient,'isEnabled').mockResolvedValue(true);
    vi.spyOn(BleClient,'requestLEScan').mockImplementation(async(_,receive)=>{
      peripheral.log.push('scan');
      receive({device:{deviceId:address,name:'Lüftlotse Test'},rssi:-50} as ScanResult);
    });
    vi.spyOn(BleClient,'stopLEScan').mockImplementation(async()=>{peripheral.log.push('scan-stop');});
    TestBed.configureTestingModule({imports:[AirMonitorPage],providers:[...routes[0].providers!,{provide:BLE_ADAPTER,useValue:peripheral}]});
    const fixture = TestBed.createComponent(AirMonitorPage); fixture.detectChanges();
    const discovery = fixture.debugElement.query(By.directive(DeviceDiscovery));
    const injector = discovery.injector;
    const connection = injector.get(BleConnection); const journal = injector.get(BleJournalSync);
    const scanner = injector.get(BleScanner); const storage = TestBed.inject(Co2Storage);
    const history = TestBed.inject(Co2History); const simulator = TestBed.inject(Co2Simulator);
    expect(TestBed.inject(CO2_SOURCE)).toBe(simulator);
    const dependencies = journal as unknown as {connection:BleConnection;storage:Co2Storage;history:Co2History};
    expect(dependencies.connection).toBe(connection); expect(dependencies.storage).toBe(storage); expect(dependencies.history).toBe(history);
    expect((connection as unknown as {scanner:BleScanner}).scanner).toBe(scanner);
    await history.whenSettled(); simulator.start(); await vi.advanceTimersByTimeAsync(1000); await history.whenSettled();
    const current = simulator.current(); const sourceState = simulator.state();
    const sourceReadings: unknown[] = []; const subscription = simulator.readings.subscribe(reading=>sourceReadings.push(reading));
    const el = discovery.nativeElement as HTMLElement;
    const button = (text:string) => Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(item=>item.textContent?.trim()===text)!;
    const until = async (check:()=>void) => {
      let error:unknown;
      for(let i=0;i<300;i++){try{check();return;}catch(e){error=e;}await new Promise<void>(resolve=>setTimeout(resolve,5));}
      throw error;
    };
    const settled = async()=>{await fixture.whenStable(); await history.whenSettled(); fixture.detectChanges();};
    const download = async()=>{
      await until(()=>{fixture.detectChanges();expect(button('Journalmessungen herunterladen').disabled).toBe(false);});
      button('Journalmessungen herunterladen').click();
      await until(()=>expect(journal.running()).toBe(false));
      await settled();
    };
    try {
      button('Gerät verbinden').click(); fixture.detectChanges();
      button('Geräte suchen').click(); await until(()=>expect(scanner.busy()).toBe(false)); await settled();
      expect(scanner.devices()).toEqual([{id:address,name:'Lüftlotse Test',rssi:-50}]);
      button('Verbinden').click(); await until(()=>expect(connection.state()).toBe('ready')); await settled();
      expect(connection.state()).toBe('ready'); expect(connection.info()?.deviceId).toBe(deviceId);
      expect(peripheral.log.slice(0,8)).toEqual(['initialize','scan','scan-stop','initialize','connect','info','subscribe','status']);
      expect(peripheral.fetches).toEqual([]); // Handshake does not start journal download.
      history.setVisible(true); await history.whenSettled();
      await download();
      expect(peripheral.fetches).toEqual([0n,2n]); expect(peripheral.acknowledged).toEqual([2n,4n]);
      expect(await storage.bleCursor(deviceId)).toBe(4n); expect(journal.savedMeasurements()).toBe(4);
      expect(history.count()).toBe(5); expect(history.rangeCount()).toBe(5);
      expect(el.querySelector('.download-result')?.textContent).toContain('abgeschlossen');

      const snapshot = async()=>{
        const db = await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('lueftlotse');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        try {
          const tx=db.transaction('measurements','readonly');const store=tx.objectStore('measurements');
          const values=store.getAll();const keys=store.getAllKeys();
          await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});
          return values.result.map((value,index)=>({key:keys.result[index],...value}));
        } finally {db.close();}
      };
      const first = await snapshot();
      const sensors = first.filter(row=>row.source==='sensor');
      expect(sensors.map(row=>row.measurementId)).toEqual(peripheral.records.map(row=>row.measurementId));
      for(const [index,row] of sensors.entries()) {
        const original=peripheral.records[index];
        expect(row).toMatchObject({deviceId,source:'sensor',syncStatus:'pending',sequence:original.sequence.toString(),
          measurementId:original.measurementId,segment:original.segmentId,bootId:original.bootId,uptimeMs:original.uptimeMs.toString(),time:Number(original.utcMs),ppm:original.ppm});
      }
      button('Trennen').click(); await until(()=>expect(connection.state()).toBe('idle')); await settled(); expect(connection.state()).toBe('idle'); expect(peripheral.subscriptions).toBe(0);
      expect(await storage.bleCursor(deviceId)).toBe(4n);
      peripheral.add(); // The ring retains old records; a new measurement appeared while disconnected.
      button('Verbinden').click(); await until(()=>expect(connection.state()).toBe('ready')); await settled();
      expect(peripheral.fetches).toEqual([0n,2n]);
      await download();
      expect(peripheral.fetches).toEqual([0n,2n,4n]); expect(peripheral.acknowledged).toEqual([2n,4n,5n]);
      expect(await storage.bleCursor(deviceId)).toBe(5n); expect(journal.savedMeasurements()).toBe(1);
      const second=await snapshot(); expect(second.slice(0,first.length)).toEqual(first);
      expect(second).toHaveLength(6); expect(new Set(second.map(row=>row.measurementId)).size).toBe(6);
      expect(second.filter(row=>row.source==='sensor').map(row=>row.measurementId)).toEqual(peripheral.records.map(row=>row.measurementId));
      expect(history.count()).toBe(6); expect(history.rangeCount()).toBe(6);
      expect(simulator.current()).toBe(current); expect(simulator.state()).toBe(sourceState); expect(sourceReadings).toEqual([]);
      expect((fixture.nativeElement as HTMLElement).querySelector('.badge')?.textContent).toBe('Simulator');
      expect((fixture.nativeElement as HTMLElement).querySelector('.measurement strong')?.textContent).toBe(String(current.ppm));
      expect(injector.get(BleJournalSync)).toBe(journal); expect(injector.get(BleConnection)).toBe(connection);
      button('Trennen').click(); await until(()=>expect(connection.state()).toBe('idle')); await settled(); expect(peripheral.subscriptions).toBe(0);
    } finally {
      subscription.unsubscribe(); simulator.stop(); journal.cancel(); await connection.disconnect().catch(()=>{});
      await scanner.stop(); await history.whenSettled(); fixture.destroy(); await storage.close();
    }
  });
});
