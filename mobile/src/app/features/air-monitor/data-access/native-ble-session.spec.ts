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

describe('native manual journal bridge and opt-in BLE_SESSION', () => {
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
    snapshot = { state: 'ready', runId: crypto.randomUUID(), info, status, lastSample: null, sampleAvailable: false, nowElapsedMs: '1000', reason: null, bindingError: null };
    bridge = {
      getState: vi.fn(async () => snapshot), start: vi.fn(async () => snapshot),
      disconnect: vi.fn(async () => snapshot = { ...snapshot, state: 'stopped' }), closeSession: vi.fn(async () => snapshot = { ...snapshot, state: 'stopped' }),
      getBinding: vi.fn(async () => ({ migrationComplete, revision: migrationComplete ? '1' : '0', binding: null })),
      migrateBinding: vi.fn(async () => { throw new Error('Must not migrate'); }),
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
    TestBed.configureTestingModule({ providers: [NativeBleSession, BleJournalSync, { provide: BLE_SESSION, useExisting: NativeBleSession },
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
  it('runs existing BleJournalSync over one opt-in session while construction performs no IO or migration', async () => {
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
  it('requires explicit migration and never invokes it from connect', async () => {
    snapshot = { ...snapshot, state: 'stopped', runId: null }; migrationComplete = false;
    const session = configure(), client = session.attachClient();
    await expect(client.connect('01:23:45:67:89:AB')).rejects.toThrow('migration');
    expect(bridge.start).not.toHaveBeenCalled(); expect(bridge.migrateBinding).not.toHaveBeenCalled();
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
  it('does not replay cached LIVE_SAMPLE or persist previews; native expiry remains authoritative', async () => {
    vi.useFakeTimers();
    const sample = { type: 0x8a, bootId: ID, sampleCounter: '1', uptimeMs: '100', ppm: 2100, receivedAtElapsedMs: '1000' };
    snapshot = { ...snapshot, lastSample: sample, sampleAvailable: true };
    const session = configure(), preview: unknown[] = []; session.previewEvents.subscribe(event => preview.push(event)); session.attachClient();
    await vi.advanceTimersByTimeAsync(0); expect(preview.filter((event: any) => event.kind === 'sample')).toHaveLength(0);
    snapshot = { ...snapshot, nowElapsedMs: '2000', lastSample: { ...sample, sampleCounter: '2', uptimeMs: '200', receivedAtElapsedMs: '2000' } };
    await vi.advanceTimersByTimeAsync(1000); expect(preview.filter((event: any) => event.kind === 'sample')).toHaveLength(1);
    snapshot = { ...snapshot, nowElapsedMs: '17000', sampleAvailable: false }; await vi.advanceTimersByTimeAsync(1000);
    expect(preview.at(-1)).toEqual({ kind: 'unavailable' }); expect(bridge.journalFetch).not.toHaveBeenCalled();
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
  it('loads native binding on attach but ignores late connect success after client revocation', async () => {
    const saved = { migrationComplete: true, revision: '1', binding: { version: 1 as const, deviceId: ID, bleAddress: '01:23:45:67:89:AB', connectionEnabled: true } };
    vi.mocked(bridge.getBinding).mockResolvedValue(saved);
    const session = configure(), client = session.attachClient(); await vi.waitFor(() => expect(session.binding()?.deviceId).toBe(ID));
    await client.disconnect(); const finalRead = deferred<typeof saved>();
    vi.mocked(bridge.getBinding).mockResolvedValueOnce(saved).mockReturnValueOnce(finalRead.promise);
    vi.mocked(bridge.start).mockImplementation(async () => snapshot = { ...snapshot, state: 'ready', runId: crypto.randomUUID() });
    const connecting = client.connect(saved.binding.bleAddress); const rejected = expect(connecting).rejects.toThrow();
    await vi.waitFor(() => expect(bridge.getBinding).toHaveBeenCalledTimes(3));
    client.revoke(); finalRead.resolve(saved); await rejected; expect(bridge.closeSession).toHaveBeenCalled();
  });
});
