import { TestBed } from '@angular/core/testing';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { BLE_ADAPTER, BleAdapter } from './ble-adapter';
import { BleConnection } from './ble-connection';
import { BleJournalSync } from './ble-journal-sync';
import { BleScanner } from './ble-scanner';
import { Co2Storage } from './co2-storage';
import { Co2History } from './co2-history';
import { batchDigest, encodeInfo, Entry, Message } from '../ble-protocol/codec';
import { FragmentAssembler, fragmentMessage } from '../ble-protocol/fragments';

const deviceId = '00112233-4455-4677-8899-aabbccddeeff';
const ready = (sequence: bigint): Entry => ({tag:1,sequence,measurementId:crypto.randomUUID(),bootId:deviceId,segmentId:deviceId,uptimeMs:sequence,utcMs:BigInt(Date.now()-1000),ppm:850});
const view = (bytes:Uint8Array) => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
describe('BleJournalSync with real storage and a fake BLE peripheral',()=>{
  let storage:Co2Storage; let connection:BleConnection; let sync:BleJournalSync;
  let notify:(value:DataView)=>void; let lost:()=>void; let eventId:number; let controls:FragmentAssembler;
  let latest:bigint; let timeValid:number; let firstUndated:bigint; let capabilities:number;
  let batches:Entry[][]; let commands:Message[]; let ackMode:'ok'|'lost'|'wrong'; let failure:number|undefined;
  let ackId:number;
  let corrupt:boolean; let wrongBegin:boolean; let hold:boolean; let onFetch:(()=>void)|undefined;
  let imported:ReturnType<typeof vi.fn>; let adapter:BleAdapter;
  const emit=(message:Message)=>{for(const frame of fragmentMessage(message,eventId++,'events'))notify(view(frame));};
  const status=(requestId:number):Extract<Message,{type:0x80}>=>({type:0x80,requestId,bootId:deviceId,oldest:latest===0n?0n:1n,latest,overwrittenThrough:0n,timeValid,firstUndated,storageState:0});
  beforeEach(()=>{
    vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);
    storage=new Co2Storage();eventId=0;controls=new FragmentAssembler('control');latest=2n;timeValid=1;firstUndated=0n;capabilities=15;
    batches=[[ready(1n)],[ready(2n)]];commands=[];ackMode='ok';failure=undefined;corrupt=false;wrongBegin=false;hold=false;onFetch=undefined;
    imported=vi.fn(async()=>{});
    adapter={available:()=>true,initialize:async()=>{},connect:async(_,callback)=>{lost=callback;controls.reset();eventId=0;},
      readInfo:async()=>view(encodeInfo(deviceId,capabilities)),subscribe:async(_,callback)=>{notify=callback;},unsubscribe:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),
      write:async(_,value)=>{
        const decoded=controls.push(new Uint8Array(value.buffer,value.byteOffset,value.byteLength));if(!decoded)return;
        const message=decoded.message;commands.push(message);
        if(message.type===1){emit(status(decoded.messageId));return;}
        if(message.type===3){
          onFetch?.();if(hold)return;
          if(failure!==undefined){if(failure===0){emit({type:0x85,requestId:decoded.messageId,bootId:deviceId,firstUndated:message.afterSequence+1n,latest});}else emit({type:255,requestId:decoded.messageId,code:failure});return;}
          const entries=batches.shift()!;const last=entries[entries.length-1];
          const begin={type:0x82,requestId:decoded.messageId+(wrongBegin?1:0),batchId:crypto.randomUUID(),afterSequence:message.afterSequence,throughSequence:last.tag===3?last.toSequence:last.sequence,count:entries.length} as const;
          const digest=await batchDigest(begin,entries);if(corrupt)digest[0]^=1;
          emit(begin);for(const entry of entries)emit({type:0x83,batchId:begin.batchId,entry});emit({type:0x84,batchId:begin.batchId,digest});
        }
        if(message.type===4){
          ackId=decoded.messageId;
          expect(await storage.bleCursor(deviceId)).toBe(message.throughSequence);
          if(ackMode!=='lost')emit({type:0x87,requestId:decoded.messageId,batchId:ackMode==='wrong'?crypto.randomUUID():message.batchId});
        }
      },
    };
    TestBed.configureTestingModule({providers:[BleConnection,BleJournalSync,{provide:BLE_ADAPTER,useValue:adapter},
      {provide:BleScanner,useValue:{stop:async()=>{}}},{provide:Co2Storage,useValue:storage},{provide:Co2History,useValue:{imported}}]});
    connection=TestBed.inject(BleConnection);sync=TestBed.inject(BleJournalSync);
  });
  afterEach(async()=>{sync.cancel();await connection.disconnect().catch(()=>{});controls.dispose();await storage.close();TestBed.resetTestingModule();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
  const connect=()=>connection.connect('native-address');
  it('imports sequential packets, persists before ACK, waits for fast ACK_ACCEPTED, then advances',async()=>{
    await connect();const result=await sync.run();expect(result).toMatchObject({status:'complete',cursor:2n,target:2n});
    expect(commands.map(m=>m.type)).toEqual([1,1,3,4,3,4]);expect(await storage.count()).toBe(2);expect(imported).toHaveBeenCalledTimes(2);
    expect((await storage.syncSnapshot()).pending).toBe(2);expect(connection.state()).toBe('ready');
    expect(await storage.newestKeyInRange(0,Date.now(),0)).toBe(2);expect(await storage.newestKeyInRange(0,Date.now(),2)).toBe(0);expect(await storage.newestKeyInRange(0,1,0)).toBe(0);
  });
  it('freezes latest and accepts the final packet completely while the journal grows',async()=>{
    batches=[[ready(1n),ready(2n),ready(3n)]];await connect();onFetch=()=>{latest=100n;emit(status(65535));};
    expect(await sync.run()).toMatchObject({status:'complete',cursor:3n,target:2n});expect(await storage.count()).toBe(3);
    expect(commands.filter(m=>m.type===3)).toHaveLength(1);
  });
  it('persists GAP and UNDATABLE and handles uint64 sequences without Number conversion',async()=>{
    latest=9007199254740995n;
    const undatable={...ready(2n),tag:2} as Entry;
    batches=[[ready(1n),undatable,{tag:3,fromSequence:3n,toSequence:latest,reason:1}]];
    await connect();expect(await sync.run()).toMatchObject({status:'complete',cursor:latest});expect(await storage.count()).toBe(1);
  });
  it.each([0,2,8,1])('requires both journal and non-destructive ACK capabilities: %s',async bits=>{
    capabilities=bits;await connect();expect((await sync.run()).status).toBe('unsupported');expect(commands.filter(m=>m.type===3)).toHaveLength(0);
  });
  it.each(['invalid','undated'])('returns time-required without inventing TIME_SET: %s',async kind=>{
    if(kind==='invalid')timeValid=0;else firstUndated=1n;
    await connect();expect((await sync.run()).status).toBe('time-required');expect(commands.map(m=>m.type)).toEqual([1,1]);
  });
  it.each([[0,'time-required'],[3,'busy'],[5,'clock-invalid']] as const)('stops on response %s without repeating FETCH',async(code,result)=>{
    failure=code;await connect();expect((await sync.run()).status).toBe(result);
    expect(commands.filter(m=>m.type===3)).toHaveLength(1);expect(await storage.bleCursor(deviceId)).toBe(0n);
  });
  it.each(['digest','begin','storage','order','limit'])('does not commit or ACK invalid/failed packets: %s',async kind=>{
    if(kind==='digest')corrupt=true;if(kind==='begin')wrongBegin=true;
    if(kind==='storage')vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore){throw new DOMException('full','QuotaExceededError');});
    if(kind==='order')batches=[[ready(2n)]];
    if(kind==='limit')batches=[Array.from({length:101},(_,i)=>ready(BigInt(i+1)))];
    await connect();expect((await sync.run()).status).toBe('error');expect(await storage.bleCursor(deviceId)).toBe(0n);
    expect(commands.filter(m=>m.type===4)).toHaveLength(0);expect(imported).not.toHaveBeenCalled();
  });
  it('rejects a wrong ACK_ACCEPTED without undoing committed records',async()=>{
    ackMode='wrong';await connect();expect((await sync.run()).status).toBe('error');expect(await storage.bleCursor(deviceId)).toBe(1n);
    expect(commands.filter(m=>m.type===3)).toHaveLength(1);expect(adapter.disconnect).toHaveBeenCalledOnce();
  });
  it('stops after lost ACK_ACCEPTED and keeps the cursor for the next explicit run',async()=>{
    ackMode='lost';await connect();
    // Keep IndexedDB scheduling native; shorten only the protocol response timer for this test.
    const timeout=globalThis.setTimeout;
    vi.spyOn(globalThis,'setTimeout').mockImplementation(((fn:TimerHandler,ms?:number,...args:unknown[])=>timeout(fn,ms===5000?30:ms,...args)) as typeof setTimeout);
    expect((await sync.run()).status).toBe('error');expect(await storage.bleCursor(deviceId)).toBe(1n);
    expect(commands.filter(m=>m.type===3)).toHaveLength(1);expect(adapter.disconnect).toHaveBeenCalledOnce();
  });
  it.each(['cancel','clear','disconnect','background'])('stops the whole run on %s and prevents parallel starts',async kind=>{
    hold=true;await connect();const pending=sync.run();await vi.waitFor(()=>expect(commands.some(m=>m.type===3)).toBe(true));
    expect((await sync.run()).status).toBe('busy');
    if(kind==='cancel')sync.cancel();
    if(kind==='clear')await storage.clear();
    if(kind==='disconnect')lost();
    if(kind==='background'){vi.spyOn(document,'hidden','get').mockReturnValue(true);document.dispatchEvent(new Event('visibilitychange'));}
    expect((await pending).status).toBe(kind==='disconnect'||kind==='background'?'disconnected':'cancelled');
    expect(await storage.bleCursor(deviceId)).toBe(0n);expect(commands.filter(m=>m.type===3)).toHaveLength(1);expect(sync.running()).toBe(false);
  });
  it('waits for matching ACK_ACCEPTED before the next FETCH and ignores a foreign requestId',async()=>{
    ackMode='lost';await connect();const pending=sync.run();
    await vi.waitFor(()=>expect(commands.filter(m=>m.type===4)).toHaveLength(1));
    const ack=commands.find(m=>m.type===4)! as Extract<Message,{type:4}>;
    expect(commands.filter(m=>m.type===3)).toHaveLength(1);
    emit({type:0x87,requestId:60000,batchId:ack.batchId});
    await Promise.resolve();expect(commands.filter(m=>m.type===3)).toHaveLength(1);
    ackMode='ok';emit({type:0x87,requestId:ackId,batchId:ack.batchId});
    expect((await pending).status).toBe('complete');
  });
  it('does not ACK or advance before commit and refreshes history only after commit',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const original=storage.importBleBatch.bind(storage);
    const write=vi.spyOn(storage,'importBleBatch').mockImplementationOnce(async(batch,signal)=>{await gate;return original(batch,signal);});
    await connect();const pending=sync.run();await vi.waitFor(()=>expect(write).toHaveBeenCalled());
    expect(await storage.bleCursor(deviceId)).toBe(0n);expect(imported).not.toHaveBeenCalled();expect(commands.filter(m=>m.type===4)).toHaveLength(0);
    release();expect((await pending).status).toBe('complete');
  });
  it('cancels a pending commit on clear without restoring history or sending ACK',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const original=storage.importBleBatch.bind(storage);
    const write=vi.spyOn(storage,'importBleBatch').mockImplementationOnce(async(batch,signal)=>{await gate;signal?.throwIfAborted();return original(batch,signal);});
    await connect();const pending=sync.run();await vi.waitFor(()=>expect(write).toHaveBeenCalled());
    await storage.clear();release();expect((await pending).status).toBe('cancelled');
    expect(await storage.bleCursor(deviceId)).toBe(0n);expect(await storage.count()).toBe(0);expect(commands.filter(m=>m.type===4)).toHaveLength(0);
  });
  it('resumes from durable cursor after lost ACK on a new explicit connection',async()=>{
    ackMode='wrong';await connect();expect((await sync.run()).status).toBe('error');
    expect(await storage.bleCursor(deviceId)).toBe(1n);ackMode='ok';await connect();
    expect((await sync.run()).status).toBe('complete');expect(await storage.count()).toBe(2);
    expect(commands.filter(m=>m.type===3).map(m=>m.type===3?m.afterSequence:0n)).toEqual([0n,1n]);
  });

});
