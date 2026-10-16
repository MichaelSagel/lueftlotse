import { TestBed } from '@angular/core/testing';
import { BLE_ADAPTER, BleAdapter } from './ble-adapter';
import { BleConnection } from './ble-connection';
import { BleScanner } from './ble-scanner';
import { encodeInfo, Message } from '../ble-protocol/codec';
import { fragmentMessage } from '../ble-protocol/fragments';

const uuid = '12345678-1234-4234-8234-123456789abc';
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const status = (requestId: number): Extract<Message, { type: 0x80 }> => ({ type: 0x80, requestId,
  bootId: uuid, oldest: 0n, latest: 0n, overwrittenThrough: 0n, timeValid: 0, firstUndated: 0n, storageState: 0 });

describe('BleConnection handshake', () => {
  let connection: BleConnection;
  let receive: (value: DataView) => void;
  let lost: () => void;
  let eventId: number;
  let calls: string[];
  let adapter: BleAdapter;
  let stop: ReturnType<typeof vi.fn>;
  const emit = (message: Message, id = eventId++) => {
    for (const frame of fragmentMessage(message, id, 'events')) receive(view(frame));
  };
  beforeEach(() => {
    vi.useFakeTimers(); eventId = 0; calls = [];
    stop = vi.fn(async () => { calls.push('stop'); });
    adapter = {
      available: vi.fn(() => true),
      initialize: vi.fn(async () => { calls.push('initialize'); }),
      connect: vi.fn(async (_, callback) => { calls.push('connect'); lost = callback; }),
      readInfo: vi.fn(async () => { calls.push('read'); return view(encodeInfo(uuid)); }),
      subscribe: vi.fn(async (_, callback) => { calls.push('subscribe'); receive = callback; }),
      unsubscribe: vi.fn(async () => { calls.push('unsubscribe'); }),
      disconnect: vi.fn(async () => { calls.push('disconnect'); }),
      write: vi.fn(async (_, value) => {
        calls.push('write'); emit(status(value.getUint16(2, true)));
      }),
    };
    TestBed.configureTestingModule({ providers: [BleConnection, { provide: BLE_ADAPTER, useValue: adapter },
      { provide: BleScanner, useValue: { stop } }] });
    connection = TestBed.inject(BleConnection);
  });
  afterEach(async () => {
    await connection.disconnect().catch(() => {});
    TestBed.resetTestingModule();
    try {
      vi.runAllTicks();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });

  it('orders the handshake, handles a response during write and independent equal IDs', async () => {
    expect(await connection.connect('address')).toEqual(status(0));
    expect(calls).toEqual(['stop', 'initialize', 'connect', 'read', 'subscribe', 'write']);
    expect(connection.info()?.deviceId).toBe(uuid); expect(connection.state()).toBe('ready');
    expect(await connection.getStatus()).toEqual(status(1));
    await connection.disconnect(); await connection.disconnect();
    expect(adapter.unsubscribe).toHaveBeenCalledOnce(); expect(adapter.disconnect).toHaveBeenCalledOnce();
  });
  it('does not call any native operation or scanner in a browser', async () => {
    vi.mocked(adapter.available).mockReturnValue(false);
    await expect(connection.connect('address')).rejects.toThrow('Android');
    expect(calls).toEqual([]);
  });
  it('waits for scan shutdown and never connects after shutdown failure', async () => {
    const barrier = deferred<void>(); stop.mockReturnValue(barrier.promise);
    const pending = connection.connect('address'); const check = expect(pending).rejects.toThrow('stop failed');
    await Promise.resolve(); expect(adapter.connect).not.toHaveBeenCalled();
    barrier.reject(new Error('stop failed')); await check; await connection.disconnect();
    expect(adapter.connect).not.toHaveBeenCalled();
  });
  it.each(['length','version','uuid','capabilities'])('rejects invalid Info: %s', async kind => {
    const bytes = encodeInfo(uuid);
    if (kind === 'version') bytes[1] = 1;
    if (kind === 'uuid') bytes[8] = 0;
    if (kind === 'capabilities') bytes[19] = 128;
    vi.mocked(adapter.readInfo).mockResolvedValue(view(kind === 'length' ? bytes.subarray(0,19) : bytes));
    await expect(connection.connect('address')).rejects.toThrow(); await connection.disconnect();
    expect(adapter.subscribe).not.toHaveBeenCalled(); expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
  });
  it('accepts zero capabilities and a DataView with a nonzero offset', async () => {
    const buffer = new Uint8Array(30); buffer.set(encodeInfo(uuid,0),5);
    vi.mocked(adapter.readInfo).mockResolvedValue(new DataView(buffer.buffer,5,20));
    await connection.connect('address'); expect(connection.info()?.capabilities).toBe(0);
  });
  it('ignores foreign request IDs and unsolicited STATUS until the matching response', async () => {
    vi.mocked(adapter.write).mockImplementation(async () => { emit(status(17)); emit(status(65535)); });
    let ready = false; const pending = connection.connect('address').then(() => { ready = true; });
    await vi.waitFor(() => expect(adapter.write).toHaveBeenCalled());
    expect(ready).toBe(false); emit(status(0)); await pending; expect(ready).toBe(true);
  });
  it.each(['connect','readInfo','subscribe'] as const)('drains late %s after cancellation and ignores old callbacks', async method => {
    const late = deferred<any>();
    const original = adapter[method];
    vi.mocked(adapter[method]).mockImplementationOnce((...args: any[]) => {
      if (method === 'connect') lost = args[1];
      if (method === 'subscribe') receive = args[1];
      return late.promise;
    });
    const abort = new AbortController(); const pending = connection.connect('address',abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(adapter[method]).toHaveBeenCalled());
    const oldReceive = receive; const oldLost = lost;
    abort.abort(new Error('cancelled')); await rejected;
    const cleanup = connection.disconnect();
    await expect(connection.connect('other')).rejects.toThrow('unavailable');
    late.resolve(method === 'readInfo' ? view(encodeInfo(uuid)) : undefined); await cleanup;
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(adapter.unsubscribe).toHaveBeenCalledTimes(method === 'subscribe' ? 1 : 0);
    expect(connection.state()).not.toBe('ready');
    // mockImplementationOnce is consumed; the original implementation handles the new session.
    expect(original).toBe(adapter[method]);
    await connection.connect('other');
    oldLost?.(); oldReceive?.(view(Uint8Array.of(0)));
    expect(connection.state()).toBe('ready');
  });
  it('rejects a second session and cleans up on disconnect while awaiting STATUS', async () => {
    vi.mocked(adapter.write).mockResolvedValue();
    const pending = connection.connect('address'); const check = expect(pending).rejects.toThrow('disconnected');
    await vi.waitFor(() => expect(adapter.write).toHaveBeenCalled());
    await expect(connection.connect('other')).rejects.toThrow('unavailable'); lost(); await check;
    await connection.disconnect(); expect(adapter.unsubscribe).toHaveBeenCalledOnce();
  });
  it('disconnects in the background without reconnecting', async () => {
    await connection.connect('address'); vi.spyOn(document,'hidden','get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange')); await connection.disconnect();
    expect(adapter.disconnect).toHaveBeenCalledOnce(); expect(adapter.connect).toHaveBeenCalledOnce();
    await expect(connection.connect('address')).rejects.toThrow('unavailable');
  });
  it('bounds the command queue and serializes requests', async () => {
    await connection.connect('address'); vi.mocked(adapter.write).mockResolvedValue();
    const requests = Array.from({length:4}, () => connection.getStatus());
    await expect(connection.getStatus()).rejects.toThrow('queue full');
    for (let id=1;id<=4;id++) {
      await vi.waitFor(() => expect(adapter.write).toHaveBeenCalledTimes(id+1)); emit(status(id)); await requests[id-1];
    }
  });
  it('times out a missing STATUS and releases subscriptions and timers', async () => {
    vi.mocked(adapter.write).mockResolvedValue();
    const pending = connection.connect('address'); const check = expect(pending).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(adapter.write).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5000); await check; await connection.disconnect();
    expect(adapter.unsubscribe).toHaveBeenCalledOnce();
  });
  it('rejects corrupt Events and handles protocol ERROR while write is pending', async () => {
    vi.mocked(adapter.write).mockImplementation(async () => { receive(view(Uint8Array.of(1))); });
    await expect(connection.connect('address')).rejects.toThrow(); await connection.disconnect();
    vi.mocked(adapter.write).mockImplementation(async (_,value) => { emit({type:255,requestId:value.getUint16(2,true),code:6}); });
    await expect(connection.connect('address')).rejects.toThrow('protocol error 6'); await connection.disconnect();
  });
  it.each(['connect','readInfo','subscribe'] as const)('bounds %s wait and cleans its late completion', async method => {
    const late = deferred<any>();
    vi.mocked(adapter[method]).mockImplementationOnce((...args: any[]) => {
      if (method === 'connect') lost = args[1];
      if (method === 'subscribe') receive = args[1];
      return late.promise;
    });
    const pending = connection.connect('address'); const check = expect(pending).rejects.toThrow('timed out');
    await vi.waitFor(() => expect(adapter[method]).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(method === 'connect' ? 10000 : 5000); await check;
    const cleanup = connection.disconnect();
    late.resolve(method === 'readInfo' ? view(encodeInfo(uuid)) : undefined); await cleanup;
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(adapter.unsubscribe).toHaveBeenCalledTimes(method === 'subscribe' ? 1 : 0);
  });

  it('does not wrap Control IDs and starts a fresh namespace after reconnect', async () => {
    await connection.connect('address');
    (connection as unknown as {session:{nextId:number}}).session.nextId = 65534;
    expect(await connection.getStatus()).toEqual(status(65534));
    await expect(connection.getStatus()).rejects.toThrow('exhausted'); await connection.disconnect();
    expect(await connection.connect('address')).toEqual(status(0));
  });

  it('cleans up a rejected subscription and attempts disconnect even if unsubscribe fails', async () => {
    vi.mocked(adapter.subscribe).mockRejectedValueOnce(new Error('subscribe failed'));
    vi.mocked(adapter.unsubscribe).mockRejectedValueOnce(new Error('unsubscribe failed'));
    await expect(connection.connect('address')).rejects.toThrow('subscribe failed');
    await expect(connection.disconnect()).rejects.toThrow('cleanup failed');
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    await expect(connection.connect('other')).rejects.toThrow('unavailable');
  });

});
