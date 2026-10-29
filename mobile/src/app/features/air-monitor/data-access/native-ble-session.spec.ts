import { TestBed } from '@angular/core/testing';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { BatchReceiver } from '../ble-protocol/batch-receiver';
import { batchDigest, Entry, Message } from '../ble-protocol/codec';
import { BLE_SESSION, BleSessionClosedError, JournalFetch } from './ble-session';
import { BLE_SERVICE_SESSION_BRIDGE, BleServiceSessionBridge, NativeJournalEvent, NativeJournalReply, NativeJournalToken, NativeServiceState, nativeMessage, nativeUint64 } from './ble-service-session-bridge';
import { NativeJournalLease } from './native-journal-lease';
import { NativeBleSession } from './native-ble-session';
import { BleJournalSync } from './ble-journal-sync';
import { Co2Storage } from './co2-storage';
import { Co2History } from './co2-history';
import { Co2Monitor } from './co2-monitor';
import { ANDROID_BLE } from './ble-platform';
import { BLE_SERVICE_BINDING_BRIDGE } from './ble-service-binding-bridge';
import { NativeBleBinding } from './native-ble-binding';
import { BleScanner } from './ble-scanner';
import { createBleBindingStorage } from './ble-binding-storage';

const ID = '00112233-4455-4677-8899-aabbccddeeff';
const info = { major: 1, minor: 1, deviceId: ID, capabilities: 31 } as const;
const status = { type: 0x80, requestId: 1, bootId: ID, oldest: '1', latest: '1', overwrittenThrough: '0', timeValid: 1, firstUndated: '0', storageState: 0 };
function deferred<T = void>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() :
    item instanceof Uint8Array ? Array.from(item, byte => byte.toString(16).padStart(2, '0')).join('') : item));
}
function ackFor(packet: JournalFetch) {
  if (packet.kind !== 'batch') throw new Error('Expected batch');
  const begin = packet.messages[0], end = packet.messages.at(-1)!;
  if (begin.type !== 0x82 || end.type !== 0x84) throw new Error('Invalid batch');
  return { type: 4, batchId: begin.batchId, count: begin.count, throughSequence: begin.throughSequence, digest: end.digest } as const;
}

describe('native manual journal bridge and Android BLE_SESSION', () => {
  let bridge: BleServiceSessionBridge;
  let snapshot: NativeServiceState;
  let token: NativeJournalToken;
  let listeners: Set<(event: NativeJournalEvent) => void>;
  let events: NativeJournalEvent[];
  let leases: NativeJournalLease[];
  let storage: Co2Storage;
  let ackAccepted: ReturnType<typeof deferred<NativeJournalReply>> | undefined;
  let beforeAck: (() => Promise<void>) | undefined;
  let holdFetch: boolean;
  let holdAcquire: ReturnType<typeof deferred<{token: NativeJournalToken}>> | undefined;
  let migrationComplete: boolean;
  let order: string[];
  const emit = (event: NativeJournalEvent) => { events.push(event); for (const receive of listeners) receive(event); };
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    storage = new Co2Storage(); listeners = new Set(); events = []; leases = []; order = []; migrationComplete = true;
    ackAccepted = undefined; beforeAck = undefined; holdFetch = false; holdAcquire = undefined;
    snapshot = { state: 'ready', runId: crypto.randomUUID(), info, status, lastSample: null, sampleAvailable: false, nowElapsedMs: '1000', reason: null, bindingError: null, permissionsGranted: true };
    bridge = {
      getState: vi.fn(async () => snapshot), start: vi.fn(async () => snapshot),
      requestPermissions: vi.fn(async () => snapshot),
      disconnect: vi.fn(async () => snapshot = { ...snapshot, state: 'stopped' }), closeSession: vi.fn(async () => snapshot = { ...snapshot, state: 'stopped' }),
      getBinding: vi.fn(async () => ({ migrationComplete, revision: migrationComplete ? '1' : '0', binding: null })),
      migrateBinding: vi.fn(async () => { migrationComplete = true; return { migrationComplete: true, revision: '1', binding: null }; }),
      forgetBinding: vi.fn(async () => ({ migrationComplete: true, revision: '2', binding: null })),
      addListener: vi.fn(async (_, receive) => { listeners.add(receive); return { remove: async () => { listeners.delete(receive); } }; }),
      journalAcquire: vi.fn(async () => {
        token = { runId: snapshot.runId!, generation: crypto.randomUUID(), clientId: crypto.randomUUID(), leaseId: crypto.randomUUID() };
        return holdAcquire ? holdAcquire.promise : { token };
      }),
      journalHeartbeat: vi.fn(async () => {}), journalRevoke: vi.fn(async () => {}),
      journalStatus: vi.fn<BleServiceSessionBridge['journalStatus']>(async () => ({ kind: 'status', message: status })),
      journalFetch: vi.fn<BleServiceSessionBridge['journalFetch']>(async input => {
        order.push('FETCH');
        if (holdFetch) return new Promise<NativeJournalReply>(() => {});
        const batchId = crypto.randomUUID(), ticketId = crypto.randomUUID();
        const afterSequence = BigInt(input.afterSequence);
        const begin = { type: 0x82, requestId: 2, batchId, afterSequence, throughSequence: afterSequence + 1n, count: 1 } as const;
        const entry: Entry = { tag: 1, sequence: begin.throughSequence, measurementId: crypto.randomUUID(), bootId: ID, segmentId: ID, uptimeMs: (1n << 64n) - 1n, utcMs: BigInt(Date.now()), ppm: 2100 };
        const digest = await batchDigest(begin, [entry]);
        const base = { token, ticketId, operationId: input.operationId };
        emit({ ...base, kind: 'BEGIN', message: json(begin) });
        emit({ ...base, kind: 'ENTRY', message: json({ type: 0x83, batchId, entry }) });
        emit({ ...base, kind: 'END', message: json({ type: 0x84, batchId, digest }) });
        return { kind: 'batch', ticketId };
      }),
      journalBeginCommit: vi.fn(async () => { order.push('TOKEN'); return { commitToken: crypto.randomUUID() }; }),
      journalCommitted: vi.fn<BleServiceSessionBridge['journalCommitted']>(async input => {
        await beforeAck?.(); order.push('ACK');
        return ackAccepted ? ackAccepted.promise : { kind: 'ack-accepted', message: { type: 0x87, requestId: 3, batchId: input.ack.batchId } };
      }),
    };
  });
  afterEach(async () => {
    for (const lease of leases) await lease.close();
    TestBed.resetTestingModule(); await storage.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function lease(signal?: AbortSignal) {
    const link = new NativeJournalLease({ generation: snapshot.runId!, clientId: crypto.randomUUID(), leaseId: crypto.randomUUID() }, info, bridge, signal ? [signal] : [], () => {});
    leases.push(link); return link;
  }
  async function packet(link: NativeJournalLease, after = 0n) {
    const result = await link.fetch(after, 100); if (result.kind !== 'batch') throw new Error('Expected batch'); return result;
  }
  function configure() {
    TestBed.configureTestingModule({ providers: [NativeBleSession, NativeBleBinding, BleJournalSync, Co2Monitor, { provide: BLE_SESSION, useExisting: NativeBleSession },
      { provide: ANDROID_BLE, useValue: true }, { provide: BleScanner, useValue: { holdStopped: vi.fn(async () => () => {}) } },
      { provide: BLE_SERVICE_BINDING_BRIDGE, useValue: bridge },
      { provide: BLE_SERVICE_SESSION_BRIDGE, useValue: bridge }, { provide: Co2Storage, useValue: storage },
      { provide: Co2History, useValue: { imported: vi.fn(async () => {}) } }] });
    return TestBed.inject(NativeBleSession);
  }
  it('runs the unchanged BatchReceiver atomic commit before ACK and awaits ACK_ACCEPTED before the next FETCH', async () => {
    const link = lease(), p = await packet(link); const ack = ackFor(p);
    ackAccepted = deferred();
    beforeAck = async () => { expect(await storage.bleCursor(ID)).toBe(1n); expect(await storage.count()).toBe(1); order.push('COMMITTED'); };
    const receiver = new BatchReceiver(ID, storage, { commitAndSend: (input, commit) => link.commitAndAcknowledge(p.token, input, commit) });
    try {
      await receiver.receive(p.messages[0]); await receiver.receive(p.messages[1]);
      const completion = receiver.receive(p.messages[2]);
      await vi.waitFor(() => expect(order).toEqual(['FETCH', 'TOKEN', 'COMMITTED', 'ACK']));
      await expect(link.fetch(1n, 100)).rejects.toThrow('ACK'); expect(bridge.journalFetch).toHaveBeenCalledOnce();
      ackAccepted.resolve({ kind: 'ack-accepted', message: { type: 0x87, requestId: 3, batchId: ack.batchId } });
      await completion; await receiver.completion; await packet(link, 1n); expect(bridge.journalFetch).toHaveBeenCalledTimes(2);
    } finally { receiver.dispose(); }
  });
  it('never confirms a pending or failed transaction and rejects duplicate tokens', async () => {
    const link = lease(), p = await packet(link), commit = deferred();
    const done = link.commitAndAcknowledge(p.token, ackFor(p), () => commit.promise);
    const failure = expect(done).rejects.toThrow('aborted transaction');
    await vi.waitFor(() => expect(bridge.journalBeginCommit).toHaveBeenCalledOnce());
    expect(bridge.journalCommitted).not.toHaveBeenCalled();
    await expect(link.commitAndAcknowledge(p.token, ackFor(p), async () => {})).rejects.toThrow('Stale');
    commit.reject(new Error('aborted transaction')); await failure; expect(bridge.journalCommitted).not.toHaveBeenCalled();
    expect(bridge.journalRevoke).toHaveBeenCalled();
  });
  it('rejects wrong batch parameters before transaction and native preparation', async () => {
    const link = lease(), p = await packet(link), commit = vi.fn(async () => {});
    await expect(link.commitAndAcknowledge(p.token, { ...ackFor(p), count: 2 }, commit)).rejects.toThrow('parameters');
    await expect(link.commitAndAcknowledge({ ...p.token, clientId: crypto.randomUUID() }, ackFor(p), commit)).rejects.toThrow('Stale');
    expect(commit).not.toHaveBeenCalled(); expect(bridge.journalBeginCommit).not.toHaveBeenCalled();
  });
  it('revokes a disappearing client during commit and ignores late completion and events', async () => {
    const client = new AbortController(), link = lease(client.signal), p = await packet(link), commit = deferred();
    const done = link.commitAndAcknowledge(p.token, ackFor(p), () => commit.promise); const rejected = expect(done).rejects.toThrow();
    await vi.waitFor(() => expect(bridge.journalBeginCommit).toHaveBeenCalledOnce());
    client.abort(new BleSessionClosedError('WebView gone')); await rejected; commit.resolve();
    for (const event of [...events]) emit(event);
    await Promise.resolve(); expect(bridge.journalCommitted).not.toHaveBeenCalled(); expect(bridge.journalRevoke).toHaveBeenCalledOnce();
  });
  it('revokes a lease acquired after the caller disappeared', async () => {
    holdAcquire = deferred(); const client = new AbortController(), link = lease(client.signal);
    const result = link.getStatus(); const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(bridge.journalAcquire).toHaveBeenCalledOnce());
    client.abort(new Error('gone')); await rejected; holdAcquire.resolve({ token });
    await vi.waitFor(() => expect(bridge.journalRevoke).toHaveBeenCalledOnce()); expect(bridge.journalStatus).not.toHaveBeenCalled();
  });
  it('loses ACK without rolling back committed IndexedDB or issuing another FETCH', async () => {
    const link = lease(), p = await packet(link); vi.mocked(bridge.journalCommitted).mockRejectedValue(new Error('ACK timeout'));
    const receiver = new BatchReceiver(ID, storage, { commitAndSend: (ack, commit) => link.commitAndAcknowledge(p.token, ack, commit) });
    try {
      await receiver.receive(p.messages[0]); await receiver.receive(p.messages[1]); await expect(receiver.receive(p.messages[2])).rejects.toThrow('ACK timeout');
      expect(await storage.bleCursor(ID)).toBe(1n); expect(await storage.count()).toBe(1);
      await expect(link.fetch(1n, 100)).rejects.toThrow(); expect(bridge.journalFetch).toHaveBeenCalledOnce();
    } finally { receiver.dispose(); }
  });
  it('rejects wrong ACK_ACCEPTED and ignores obsolete connection and fetch events', async () => {
    const link = lease(), p = await packet(link), old = [...events];
    await link.commitAndAcknowledge(p.token, ackFor(p), async () => {});
    holdFetch = true; const waiting = link.fetch(1n, 100), rejected = expect(waiting).rejects.toThrow();
    await vi.waitFor(() => expect(bridge.journalFetch).toHaveBeenCalledTimes(2));
    for (const event of old) emit(event); expect(link.signal.aborted).toBe(false);
    emit({ kind: 'REVOKED', token: { ...token, generation: crypto.randomUUID() } }); expect(link.signal.aborted).toBe(false);
    emit({ kind: 'REVOKED', token, reason: 'connection lost' }); await rejected;
    const second = lease(), next = await packetAfterRelease(second);
    vi.mocked(bridge.journalCommitted).mockResolvedValue({ kind: 'ack-accepted', message: { type: 0x87, requestId: 4, batchId: crypto.randomUUID() } });
    await expect(second.commitAndAcknowledge(next.token, ackFor(next), async () => {})).rejects.toThrow('ACK_ACCEPTED');
  });
  async function packetAfterRelease(link: NativeJournalLease) { holdFetch = false; return packet(link); }
  it('preserves the entire uint64 range and rejects lossy numeric bridge input', async () => {
    const max = (1n << 64n) - 1n, link = lease(), p = await packet(link, max - 1n), ack = ackFor(p);
    expect(ack.throughSequence).toBe(max);
    expect(p.messages[1]).toMatchObject({ entry: { sequence: max, uptimeMs: max } });
    await link.commitAndAcknowledge(p.token, ack, async () => {});
    expect(bridge.journalCommitted).toHaveBeenCalledWith(expect.objectContaining({ ack: expect.objectContaining({ throughSequence: max.toString() }) }));
    expect(nativeUint64('0')).toBe(0n); expect(nativeUint64(max.toString())).toBe(max);
    for (const invalid of [Number(max), '-1', '01', (max + 1n).toString()]) expect(() => nativeUint64(invalid)).toThrow();
    expect(() => nativeMessage({ ...status, latest: 9007199254740992 })).toThrow();
    await expect(link.fetch(0n, 101)).rejects.toThrow();
  });
  it('stops a hanging heartbeat and revokes the lease with no ACK', async () => {
    vi.useFakeTimers(); const link = lease(); await link.getStatus();
    vi.mocked(bridge.journalHeartbeat).mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(6000); expect(link.signal.aborted).toBe(true); expect(bridge.journalRevoke).toHaveBeenCalledOnce();
    expect(bridge.journalCommitted).not.toHaveBeenCalled();
  });
  it('runs existing BleJournalSync over the shared native session while construction performs no IO', async () => {
    const session = configure(); expect(bridge.getState).not.toHaveBeenCalled(); expect(TestBed.inject(BLE_SESSION)).toBe(session);
    const page = session.attachClient(), discovery = session.attachClient(), sync = TestBed.inject(BleJournalSync);
    await vi.waitFor(() => expect(session.state()).toBe('ready'));
    expect(await sync.run()).toMatchObject({ status: 'complete', cursor: 1n }); expect(await storage.count()).toBe(1);
    expect(bridge.journalAcquire).toHaveBeenCalledOnce(); expect(bridge.start).not.toHaveBeenCalled(); expect(bridge.migrateBinding).not.toHaveBeenCalled();
    page.revoke(); discovery.revoke();
  });
  it('allows only one lease and revoked logical clients cannot submit commands', async () => {
    const session = configure(), first = session.attachClient(), second = session.attachClient();
    await vi.waitFor(() => expect(session.state()).toBe('ready')); const link = first.journal();
    expect(() => second.journal()).toThrow('busy'); await link.getStatus(); first.revoke(); await link.close();
    expect(() => first.journal()).toThrow(); const next = second.journal(); await next.getStatus(); await next.close();
    expect(bridge.start).not.toHaveBeenCalled(); expect(bridge.disconnect).not.toHaveBeenCalled();
  });
  it('migrates once before first connect and never starts automatically', async () => {
    snapshot = { ...snapshot, state: 'stopped', runId: null }; migrationComplete = false;
    const session = configure(), client = session.attachClient();
    await vi.waitFor(() => expect(session.bindingLoading()).toBe(false));
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(bridge.start).not.toHaveBeenCalled();
    vi.mocked(bridge.start).mockImplementation(async () => snapshot = { ...snapshot, state: 'ready', runId: crypto.randomUUID() });
    await client.connect('01:23:45:67:89:AB'); expect(bridge.start).toHaveBeenCalledOnce();
    expect(bridge.requestPermissions).toHaveBeenCalledOnce(); expect(bridge.migrateBinding).toHaveBeenCalledOnce();
  });
  it('revokes on WebView hidden and native generation change without stopping an idle service', async () => {
    const session = configure(), client = session.attachClient(); await vi.waitFor(() => expect(session.state()).toBe('ready'));
    const link = client.journal(); await link.getStatus();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    expect(link.signal.aborted).toBe(true); await link.close(); expect(bridge.disconnect).not.toHaveBeenCalled();
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    const fresh = client.journal(); await fresh.getStatus(); snapshot = { ...snapshot, runId: crypto.randomUUID() };
    await vi.waitFor(() => expect(fresh.signal.aborted).toBe(true), { timeout: 2000 });
  });
  it('restores cached LIVE_SAMPLE with original age without persisting or refreshing its receipt', async () => {
    vi.useFakeTimers();
    const sample = { type: 0x8a, bootId: ID, sampleCounter: '1', uptimeMs: '100', ppm: 2100, receivedAtElapsedMs: '1000' };
    snapshot = { ...snapshot, lastSample: sample, sampleAvailable: true };
    const session = configure(), preview: unknown[] = []; session.previewEvents.subscribe(event => preview.push(event)); session.attachClient();
    await vi.advanceTimersByTimeAsync(0); expect(preview.filter((event: any) => event.kind === 'sample')).toHaveLength(1);
    snapshot = { ...snapshot, nowElapsedMs: '2000', lastSample: { ...sample, sampleCounter: '2', uptimeMs: '200', receivedAtElapsedMs: '2000' } };
    await vi.advanceTimersByTimeAsync(1000); expect(preview.filter((event: any) => event.kind === 'sample')).toHaveLength(2);
    snapshot = { ...snapshot, nowElapsedMs: '17000', sampleAvailable: false }; await vi.advanceTimersByTimeAsync(1000);
    expect(preview.at(-1)).toEqual({ kind: 'unavailable', reason: 'stale' }); expect(bridge.journalFetch).not.toHaveBeenCalled();
    vi.useRealTimers(); expect(await storage.count()).toBe(0);
  });
  it('ignores a snapshot issued for a previous group of attached clients', async () => {
    vi.useFakeTimers(); const old = deferred<NativeServiceState>();
    vi.mocked(bridge.getState).mockReturnValueOnce(old.promise);
    const session = configure(), first = session.attachClient(); first.revoke(); session.attachClient();
    const stale = { ...snapshot }; snapshot = { ...snapshot, runId: crypto.randomUUID() };
    old.resolve(stale); await vi.advanceTimersByTimeAsync(0); expect(session.state()).toBe('idle');
    await vi.advanceTimersByTimeAsync(1000); expect(session.state()).toBe('ready');
    const client = session.attachClient(), link = client.journal(); await link.getStatus();
    expect(bridge.journalAcquire).toHaveBeenCalledWith({ runId: snapshot.runId }); await link.close();
  });
  it('loads native binding and does not close a started service when its connect waiter disappears', async () => {
    const saved = { migrationComplete: true, revision: '1', binding: { version: 1 as const, deviceId: ID, bleAddress: '01:23:45:67:89:AB', connectionEnabled: true } };
    vi.mocked(bridge.getBinding).mockResolvedValue(saved);
    const session = configure(), client = session.attachClient(); await vi.waitFor(() => expect(session.binding()?.deviceId).toBe(ID));
    await client.disconnect(); vi.mocked(bridge.closeSession).mockClear(); const started = deferred<NativeServiceState>();
    vi.mocked(bridge.start).mockReturnValueOnce(started.promise);
    const connecting = client.connect(saved.binding.bleAddress); const rejected = expect(connecting).rejects.toThrow();
    await vi.waitFor(() => expect(bridge.start).toHaveBeenCalledOnce());
    client.revoke(); started.resolve({ ...snapshot, state: 'ready', runId: crypto.randomUUID() }); await rejected;
    expect(bridge.closeSession).not.toHaveBeenCalled(); expect(bridge.disconnect).not.toHaveBeenCalled();
  });
  it('blocks connect on migration and permission failures, without invoking another transport', async () => {
    snapshot = { ...snapshot, state: 'stopped', runId: null }; migrationComplete = false;
    vi.mocked(bridge.migrateBinding).mockRejectedValue(new Error('disk unavailable'));
    const session = configure(), client = session.attachClient();
    await vi.waitFor(() => expect(session.bindingLoading()).toBe(false));
    await expect(client.connect('01:23:45:67:89:AB')).rejects.toThrow('migration failed');
    expect(session.bindingError()).toContain('migration failed'); expect(bridge.start).not.toHaveBeenCalled(); expect(bridge.requestPermissions).not.toHaveBeenCalled();
    vi.mocked(bridge.migrateBinding).mockImplementation(async () => { migrationComplete = true; return { migrationComplete: true, revision: '1', binding: null }; });
    vi.mocked(bridge.requestPermissions).mockResolvedValue({ ...snapshot, permissionsGranted: false });
    await expect(client.connect('01:23:45:67:89:AB')).rejects.toThrow('BLE permissions'); expect(bridge.start).not.toHaveBeenCalled();
  });
  it('waits for confirmed scan stop, blocks on failure and passes the stored UUID to the service', async () => {
    snapshot = { ...snapshot, state: 'stopped', runId: null };
    vi.mocked(bridge.getBinding).mockResolvedValue({ migrationComplete: true, revision: '1', binding: { version: 1, deviceId: ID, bleAddress: '01:23:45:67:89:AB', connectionEnabled: true } });
    const session = configure(), client = session.attachClient(), stopped = deferred<() => void>(), release = vi.fn();
    const scanner = TestBed.inject(BleScanner); vi.mocked(scanner.holdStopped).mockReturnValueOnce(stopped.promise);
    const connecting = client.connect('11:23:45:67:89:AB');
    await Promise.resolve(); expect(bridge.start).not.toHaveBeenCalled(); expect(bridge.requestPermissions).not.toHaveBeenCalled();
    vi.mocked(bridge.start).mockImplementation(async () => snapshot = { ...snapshot, state: 'ready', runId: crypto.randomUUID() });
    stopped.resolve(release); await connecting;
    expect(bridge.start).toHaveBeenCalledWith({ bleAddress: '11:23:45:67:89:AB', expectedDeviceId: ID }); expect(release).toHaveBeenCalledOnce();
    await client.disconnect(); vi.mocked(bridge.start).mockClear();
    vi.mocked(scanner.holdStopped).mockRejectedValueOnce(new Error('scan stop uncertain'));
    await expect(client.connect('01:23:45:67:89:AB')).rejects.toThrow('scan stop'); expect(bridge.start).not.toHaveBeenCalled();
  });
  it('restores only the remaining sample lifetime after screen lock and never makes expired data fresh', async () => {
    vi.useFakeTimers();
    const sample = { type: 0x8a, bootId: ID, sampleCounter: '1', uptimeMs: '100', ppm: 2100, receivedAtElapsedMs: '1000' };
    snapshot = { ...snapshot, lastSample: sample, sampleAvailable: true, nowElapsedMs: '6000' };
    configure(); const monitor = TestBed.inject(Co2Monitor); await vi.advanceTimersByTimeAsync(0); expect(monitor.current()?.ppm).toBe(2100);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(2000); expect(bridge.disconnect).not.toHaveBeenCalled(); expect(bridge.closeSession).not.toHaveBeenCalled();
    snapshot = { ...snapshot, nowElapsedMs: '15000' }; hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0); expect(monitor.current()?.ppm).toBe(2100);
    await vi.advanceTimersByTimeAsync(1000); expect(monitor.current()).toBeNull();
    snapshot = { ...snapshot, nowElapsedMs: '25000', sampleAvailable: false };
    hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0); expect(monitor.sensorState()).toBe('stale'); expect(monitor.current()).toBeNull();
    TestBed.resetTestingModule(); expect(bridge.closeSession).not.toHaveBeenCalled();
  });
  it('imports the existing IDB binding once and reads only native identity after WebView recreation', async () => {
    snapshot = { ...snapshot, state: 'stopped', runId: null }; migrationComplete = false;
    const binding = { version: 1 as const, deviceId: ID, bleAddress: '01:23:45:67:89:AB', connectionEnabled: true };
    const legacy = createBleBindingStorage(() => bridge.getBinding()); await legacy.write(binding);
    let nativeBinding: typeof binding | null = null;
    vi.mocked(bridge.getBinding).mockImplementation(async () => ({ migrationComplete, revision: migrationComplete ? '1' : '0', binding: nativeBinding }));
    vi.mocked(bridge.migrateBinding).mockImplementation(async input => {
      expect(await legacy.beginNativeMigration()).toEqual(binding);
      expect(input.binding).toEqual(binding); nativeBinding = binding; migrationComplete = true;
      return { migrationComplete: true, revision: '1', binding };
    });
    const first = configure(); first.attachClient();
    await vi.waitFor(() => expect(first.binding()).toEqual(binding));
    expect(await legacy.beginNativeMigration()).toBeNull(); await expect(legacy.write(binding)).rejects.toThrow('native repository');
    TestBed.resetTestingModule(); const next = configure(); next.attachClient();
    await vi.waitFor(() => expect(next.binding()).toEqual(binding));
    expect(bridge.migrateBinding).toHaveBeenCalledOnce(); expect(bridge.start).not.toHaveBeenCalled();
  });
  it('disables saved connection intent with a revision when no native run survived process restart', async () => {
    snapshot = { ...snapshot, state: 'stopped', runId: null };
    const binding = { version: 1 as const, deviceId: ID, bleAddress: '01:23:45:67:89:AB', connectionEnabled: true };
    let saved = { migrationComplete: true, revision: '7', binding };
    vi.mocked(bridge.getBinding).mockImplementation(async () => saved);
    vi.mocked(bridge.disconnect).mockImplementation(async () => { saved = { ...saved, revision: '8', binding: { ...binding, connectionEnabled: false } }; return snapshot; });
    const session = configure(), client = session.attachClient(); await vi.waitFor(() => expect(session.binding()).toEqual(binding));
    await client.disconnectByUser(); expect(bridge.disconnect).toHaveBeenCalledWith({ revision: '7' });
    expect(session.binding()?.connectionEnabled).toBe(false); expect(bridge.start).not.toHaveBeenCalled();
  });
  it('still invokes native save-or-close for a live run when binding reads fail', async () => {
    const session = configure(), client = session.attachClient(); await vi.waitFor(() => expect(session.bindingLoading()).toBe(false));
    vi.mocked(bridge.getBinding).mockRejectedValue(new Error('unreadable binding'));
    const runId = snapshot.runId!;
    await expect(client.disconnectByUser()).rejects.toThrow('unreadable binding');
    expect(bridge.disconnect).toHaveBeenCalledWith({ runId }); expect(snapshot.state).toBe('stopped');
    expect(session.bindingError()).toContain('unreadable binding');
  });
  it('reflects notification disconnect and retains a native persistence error across successful reads', async () => {
    const binding = { version: 1 as const, deviceId: ID, bleAddress: '01:23:45:67:89:AB', connectionEnabled: true };
    let saved = { migrationComplete: true, revision: '1', binding };
    vi.mocked(bridge.getBinding).mockImplementation(async () => saved);
    const session = configure(); session.attachClient(); await vi.waitFor(() => expect(session.binding()).toEqual(binding));
    saved = { ...saved, revision: '2', binding: { ...binding, connectionEnabled: false } };
    snapshot = { ...snapshot, state: 'stopped' };
    await vi.waitFor(() => expect(session.binding()?.connectionEnabled).toBe(false), { timeout: 2000 });
    snapshot = { ...snapshot, bindingError: 'Verbindungsabsicht nicht gespeichert' };
    await vi.waitFor(() => expect(session.bindingError()).toContain('nicht gespeichert'), { timeout: 2000 });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'));
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(session.bindingLoading()).toBe(false));
    expect(session.bindingError()).toContain('nicht gespeichert'); expect(bridge.start).not.toHaveBeenCalled();
  });
  it('forgets through the revision-checked native tombstone without sending a separate early close', async () => {
    const session = configure(), client = session.attachClient(); await vi.waitFor(() => expect(session.bindingLoading()).toBe(false));
    vi.mocked(bridge.forgetBinding).mockImplementation(async () => {
      expect(bridge.closeSession).not.toHaveBeenCalled(); expect(bridge.disconnect).not.toHaveBeenCalled();
      snapshot = { ...snapshot, state: 'stopped' }; return { migrationComplete: true, revision: '2', binding: null };
    });
    await client.forgetDevice(); expect(bridge.forgetBinding).toHaveBeenCalledWith({ revision: '1' });
    expect(session.binding()).toBeNull(); expect(session.state()).toBe('idle'); expect(bridge.start).not.toHaveBeenCalled();
  });
});
