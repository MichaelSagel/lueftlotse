import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { BleClient, ScanResult } from '@capacitor-community/bluetooth-le';
import { BleScanner } from './ble-scanner';

describe('BleScanner', () => {
  let scanner: BleScanner;
  let result: (value: ScanResult) => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.spyOn(BleClient, 'initialize').mockResolvedValue();
    vi.spyOn(BleClient, 'isEnabled').mockResolvedValue(true);
    vi.spyOn(BleClient, 'requestLEScan').mockImplementation(async (_, callback) => { result = callback; });
    vi.spyOn(BleClient, 'stopLEScan').mockResolvedValue();
    TestBed.configureTestingModule({ providers: [BleScanner] });
    scanner = TestBed.inject(BleScanner);
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('never invokes the native plugin in a browser', async () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [BleScanner] });
    await TestBed.inject(BleScanner).start();
    expect(BleClient.initialize).not.toHaveBeenCalled();
  });
  it('holds new searches until connect finishes and confirms an unknown previous WebView scan', async () => {
    let finish!: () => void;
    vi.mocked(BleClient.stopLEScan).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const holding = scanner.holdStopped(); await vi.waitFor(() => expect(finish).toBeDefined());
    await scanner.start(); expect(BleClient.requestLEScan).not.toHaveBeenCalled();
    finish(); const release = await holding; await scanner.start(); expect(BleClient.requestLEScan).not.toHaveBeenCalled();
    release(); release(); await scanner.start(); expect(BleClient.requestLEScan).toHaveBeenCalledOnce();
  });
  it('requires confirmed cleanup after a rejected native scan launch', async () => {
    vi.mocked(BleClient.requestLEScan).mockRejectedValueOnce(new Error('uncertain launch'));
    vi.mocked(BleClient.stopLEScan).mockRejectedValueOnce(new Error('uncertain stop')).mockRejectedValueOnce(new Error('uncertain stop'));
    await scanner.start(); expect(scanner.state()).toBe('error');
    await expect(scanner.holdStopped()).rejects.toThrow('uncertain stop');
    const release = await scanner.holdStopped(); release(); expect(BleClient.stopLEScan).toHaveBeenCalledTimes(4);
  });
  it('starts only explicitly, uses no location or UUID filter and deduplicates devices', async () => {
    expect(BleClient.initialize).not.toHaveBeenCalled();
    await scanner.start();
    expect(BleClient.initialize).toHaveBeenCalledWith({ androidNeverForLocation: true });
    expect(BleClient.requestLEScan).toHaveBeenCalledWith({ allowDuplicates: true }, expect.any(Function));
    result({ device: { deviceId: 'a' }, rssi: -80 } as ScanResult);
    expect(scanner.devices()[0].name).toBe('Unbekanntes Gerät');
    result({ device: { deviceId: 'a', name: 'Sensor' }, rssi: -50 } as ScanResult);
    expect(scanner.devices()).toEqual([{ id: 'a', name: 'Sensor', rssi: -50 }]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(BleClient.stopLEScan).toHaveBeenCalledTimes(1);
    expect(scanner.state()).toBe('done');
    result({ device: { deviceId: 'late' } } as ScanResult);
    expect(scanner.devices()).toHaveLength(1);
  });
  it('stops manually and clears the timeout', async () => {
    await scanner.start();
    await scanner.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(BleClient.stopLEScan).toHaveBeenCalledTimes(1);
    expect(scanner.message()).toBe('Keine Geräte gefunden.');
  });
  it('stops when the document goes into the background', async () => {
    await scanner.start();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(BleClient.stopLEScan).toHaveBeenCalledOnce();
  });
  it('does not start after cancellation while permission is pending', async () => {
    let ready!: () => void;
    vi.mocked(BleClient.initialize).mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const pending = scanner.start();
    await vi.waitFor(() => expect(ready).toBeDefined());
    let stopped = false;
    const stop = scanner.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(scanner.busy()).toBe(true);
    ready();
    await Promise.all([pending, stop]);
    expect(BleClient.requestLEScan).not.toHaveBeenCalled();
    expect(scanner.busy()).toBe(false);
  });
  it('cleans up a scan that finishes starting after cancellation', async () => {
    let ready!: () => void;
    vi.mocked(BleClient.requestLEScan).mockImplementation(() => new Promise<void>(resolve => { ready = resolve; }));
    const pending = scanner.start();
    await vi.waitFor(() => expect(ready).toBeDefined());
    let stopped = false;
    const stop = scanner.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(scanner.busy()).toBe(true);
    ready();
    await Promise.all([pending, stop]);
    expect(BleClient.stopLEScan).toHaveBeenCalledOnce();
    expect(scanner.state()).toBe('done');
  });

  it('shares the late-start barrier, rejects both callers on native stop failure and allows cleanup retry', async () => {
    let ready!: () => void;
    vi.mocked(BleClient.requestLEScan).mockImplementationOnce(async (_,callback) => {
      result = callback; await new Promise<void>(resolve => { ready = resolve; });
    });
    const pending = scanner.start();
    await vi.waitFor(() => expect(ready).toBeDefined());
    const first = scanner.stop(); const second = scanner.stop();
    expect(second).toBe(first);
    const failure = new Error('late stop failed');
    vi.mocked(BleClient.stopLEScan).mockRejectedValueOnce(failure);
    const checks = Promise.all([expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)]);
    result({device:{deviceId:'stale'}} as ScanResult); expect(scanner.devices()).toEqual([]);
    ready(); await pending; await checks;
    expect(scanner.state()).toBe('error'); expect(scanner.busy()).toBe(false);
    expect(BleClient.stopLEScan).toHaveBeenCalledTimes(1);
    await scanner.stop(); await scanner.stop();
    expect(BleClient.stopLEScan).toHaveBeenCalledTimes(2);
    await scanner.start();
    expect(BleClient.requestLEScan).toHaveBeenCalledTimes(2);
  });

  it('awaits native cleanup after late launch and rejects callbacks from the previous scan', async () => {
    let launch!: () => void; let finishStop!: () => void;
    vi.mocked(BleClient.requestLEScan).mockImplementationOnce(async (_,callback) => {
      result=callback; await new Promise<void>(resolve=>{launch=resolve;});
    });
    const pending=scanner.start(); await vi.waitFor(()=>expect(launch).toBeDefined());
    const oldCallback=result;
    vi.mocked(BleClient.stopLEScan).mockImplementationOnce(()=>new Promise<void>(resolve=>{finishStop=resolve;}));
    let done=false; const stopping=scanner.stop().then(()=>{done=true;});
    launch(); await pending; await vi.waitFor(()=>expect(finishStop).toBeDefined());
    expect(done).toBe(false); expect(scanner.busy()).toBe(true);
    await scanner.start(); expect(BleClient.requestLEScan).toHaveBeenCalledTimes(1);
    finishStop(); await stopping; await scanner.start();
    oldCallback({device:{deviceId:'old'}} as ScanResult);
    result({device:{deviceId:'new'}} as ScanResult);
    expect(scanner.devices().map(d=>d.id)).toEqual(['new']);
  });

  it('handles background cancellation during launch and a failed background stop without rejection', async () => {
    let ready!: () => void;
    vi.mocked(BleClient.requestLEScan).mockImplementationOnce(()=>new Promise<void>(resolve=>{ready=resolve;}));
    const pending=scanner.start(); await vi.waitFor(()=>expect(ready).toBeDefined());
    vi.mocked(BleClient.stopLEScan).mockRejectedValueOnce(new Error('background stop failed'));
    vi.spyOn(document,'hidden','get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    ready(); await pending; await vi.waitFor(()=>expect(scanner.busy()).toBe(false));
    expect(scanner.state()).toBe('error'); expect(BleClient.stopLEScan).toHaveBeenCalledOnce();
    await scanner.stop(); expect(BleClient.stopLEScan).toHaveBeenCalledTimes(2);
  });

  it('reports Bluetooth off without scanning', async () => {
    vi.mocked(BleClient.isEnabled).mockResolvedValue(false);
    await scanner.start();
    expect(scanner.state()).toBe('off');
    expect(BleClient.requestLEScan).not.toHaveBeenCalled();
  });
  it('serializes overlapping stops and permits a later search', async () => {
    await scanner.start();
    let ready!: () => void;
    vi.mocked(BleClient.stopLEScan).mockImplementationOnce(() => new Promise<void>(resolve => { ready = resolve; }));
    const first = scanner.stop();
    const second = scanner.stop();
    expect(scanner.busy()).toBe(true);
    await scanner.start();
    expect(BleClient.requestLEScan).toHaveBeenCalledTimes(1);
    ready(); await Promise.all([first, second]);
    expect(scanner.busy()).toBe(false);
    await scanner.start();
    expect(BleClient.requestLEScan).toHaveBeenCalledTimes(2);
  });
  it('reports a stop failure and retries cleanup before another scan', async () => {
    await scanner.start();
    vi.mocked(BleClient.stopLEScan).mockRejectedValueOnce(new Error('Stop failed'));
    await expect(scanner.stop()).rejects.toThrow('Stop failed');
    expect(scanner.state()).toBe('error');
    await scanner.start();
    expect(BleClient.stopLEScan).toHaveBeenCalledTimes(2);
    expect(BleClient.requestLEScan).toHaveBeenCalledTimes(2);
  });
  it.each([['Permission denied.', 'denied'], ['BLE is not supported.', 'error']])('handles %s', async (message, state) => {
    vi.mocked(BleClient.initialize).mockRejectedValue(new Error(message));
    await scanner.start();
    expect(scanner.state()).toBe(state);
    expect(scanner.busy()).toBe(false);
  });
  it('stops on destruction', async () => {
    await scanner.start();
    TestBed.resetTestingModule();
    expect(BleClient.stopLEScan).toHaveBeenCalledOnce();
  });
});
