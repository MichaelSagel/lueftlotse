import { TestBed } from '@angular/core/testing';
import { batchDigest, encodeInfo, Message } from '../ble-protocol/codec';
import { FragmentAssembler, fragmentMessage } from '../ble-protocol/fragments';
import { BLE_ADAPTER, BleAdapter } from './ble-adapter';
import { testBleBindingStorage } from './ble-binding.testing';
import { BleConnection } from './ble-connection';
import { BleScanner } from './ble-scanner';
import { BLE_SESSION, BleJournalLease, JournalFetch } from './ble-session';

const uuid = '00112233-4455-4677-8899-aabbccddeeff';
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function ackFor(packet: JournalFetch): Extract<Message, { type: 4 }> {
  if (packet.kind !== 'batch') throw new Error('Expected batch');
  const begin = packet.messages[0]; const end = packet.messages.at(-1)!;
  if (begin.type !== 0x82 || end.type !== 0x84) throw new Error('Invalid packet');
  return { type: 4, batchId: begin.batchId, count: begin.count, throughSequence: begin.throughSequence, digest: end.digest };
}

describe('BLE_SESSION capabilities on one real BleConnection', () => {
  let connection: BleConnection; let adapter: BleAdapter;
  let notify: (value: DataView) => void; let lost: () => void;
  let controls: FragmentAssembler; let eventId: number;
  let commands: Message[]; let ackId: number; let replyAck: boolean; let holdFetch: boolean;
  let ackWrite: Promise<void> | undefined;
  const emit = (message: Message) => {
    for (const frame of fragmentMessage(message, eventId++, 'events')) notify(view(frame));
  };
  const status = (requestId: number): Extract<Message, { type: 0x80 }> => ({ type: 0x80, requestId, bootId: uuid,
    oldest: 1n, latest: 20n, overwrittenThrough: 0n, timeValid: 1, firstUndated: 0n, storageState: 0 });
  beforeEach(() => {
    commands = []; eventId = 0; replyAck = true; holdFetch = false; ackWrite = undefined;
    controls = new FragmentAssembler('control');
    adapter = {
      available: () => true, initialize: vi.fn(async () => {}),
      connect: vi.fn(async (_, callback) => { lost = callback; controls.reset(); eventId = 0; }),
      readInfo: async () => view(encodeInfo(uuid, 31, 1)), subscribe: async (_, callback) => { notify = callback; },
      unsubscribe: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
      write: vi.fn(async (_, value) => {
        const decoded = controls.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
        if (!decoded) return;
        const message = decoded.message; commands.push(message);
        if (message.type === 1) emit(status(decoded.messageId));
        if (message.type === 3 && !holdFetch) {
          const begin = { type: 0x82, requestId: decoded.messageId, batchId: crypto.randomUUID(), afterSequence: message.afterSequence,
            throughSequence: message.afterSequence + 1n, count: 1 } as const;
          const entry = { tag: 1, sequence: begin.throughSequence, measurementId: crypto.randomUUID(), bootId: uuid, segmentId: uuid,
            uptimeMs: 9007199254740993n, utcMs: 1700000000000n, ppm: 900 } as const;
          const digest = await batchDigest(begin, [entry]);
          emit(begin); emit({ type: 0x83, batchId: begin.batchId, entry }); emit({ type: 0x84, batchId: begin.batchId, digest });
        }
        if (message.type === 4) {
          ackId = decoded.messageId;
          if (replyAck) emit({ type: 0x87, requestId: ackId, batchId: message.batchId });
          await ackWrite;
        }
      }),
    };
    TestBed.configureTestingModule({ providers: [BleConnection, { provide: BLE_SESSION, useExisting: BleConnection },
      testBleBindingStorage().provider, { provide: BLE_ADAPTER, useValue: adapter }, { provide: BleScanner, useValue: { stop: async () => {} } }] });
    connection = TestBed.inject(BleConnection);
  });
  afterEach(async () => { await connection.disconnect(); controls.dispose(); TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  async function packet(lease: BleJournalLease, after = 0n) {
    const result = await lease.fetch(after, 100);
    if (result.kind !== 'batch') throw new Error('Expected batch');
    return result;
  }

  it('aliases the existing owner and revokes commands without opening another GATT', async () => {
    const session = TestBed.inject(BLE_SESSION); expect(session).toBe(connection);
    const first = session.attachClient(); const second = session.attachClient();
    await first.connect('sensor'); await expect(second.connect('sensor')).rejects.toThrow('unavailable');
    first.revoke(); await expect(first.disconnectByUser()).rejects.toThrow('revoked');
    await expect(first.forgetDevice()).rejects.toThrow('revoked'); await expect(first.connect('sensor')).rejects.toThrow('revoked');
    expect(adapter.connect).toHaveBeenCalledOnce(); expect(adapter.disconnect).not.toHaveBeenCalled();
    expect(connection.binding()?.connectionEnabled).toBe(true);
    await second.disconnectByUser(); expect(connection.binding()?.connectionEnabled).toBe(false);
  });

  it('revokes an unfinished handshake and ignores its late STATUS on the next connection', async () => {
    const write = vi.mocked(adapter.write); const normalWrite = write.getMockImplementation()!;
    write.mockResolvedValue();
    const client = connection.attachClient(); const pending = client.connect('sensor'); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    const oldNotify = notify; const oldLost = lost; client.revoke(); await rejected; await connection.disconnect();
    expect(connection.binding()).toBeNull(); write.mockImplementation(normalWrite);
    await connection.attachClient().connect('sensor');
    for (const frame of fragmentMessage(status(0), 0, 'events')) oldNotify(view(frame));
    oldLost(); expect(connection.state()).toBe('ready');
  });

  it('cannot use a released lease or let its cleanup release another client lease', async () => {
    await connection.connect('sensor');
    const first = connection.attachClient(); const old = first.journal(); old.release();
    const other = connection.attachClient(); const fresh = other.journal();
    old.release(); await old.close(); first.revoke();
    await expect(old.getStatus()).rejects.toThrow(); await expect(old.fetch(0n, 1)).rejects.toThrow();
    expect(() => other.journal()).toThrow('unavailable');
    expect((await fresh.getStatus()).bootId).toBe(uuid); fresh.release();
    expect(adapter.disconnect).not.toHaveBeenCalled();
  });

  it('fences generation/client/lease/ticket and consumes the batch token once', async () => {
    await connection.connect('sensor'); const lease = connection.attachClient().journal(); const batch = await packet(lease);
    const ack = ackFor(batch); const commit = vi.fn(async () => {});
    for (const field of ['generation', 'clientId', 'leaseId', 'ticketId'] as const) {
      await expect(lease.commitAndAcknowledge({ ...batch.token, [field]: 'obsolete' }, ack, commit)).rejects.toThrow('token');
    }
    await expect(lease.commitAndAcknowledge(batch.token, { ...ack, throughSequence: 2n }, commit)).rejects.toThrow('match');
    expect(commit).not.toHaveBeenCalled(); expect(commands.filter(m => m.type === 4)).toHaveLength(0);
    await lease.commitAndAcknowledge(batch.token, ack, commit);
    await expect(lease.commitAndAcknowledge(batch.token, ack, commit)).rejects.toThrow('token');
    expect(commit).toHaveBeenCalledOnce(); expect(commands.filter(m => m.type === 4)).toHaveLength(1); lease.release();
  });

  it('gates ACK on commit, and FETCH on the matching ACK_ACCEPTED independently of write completion', async () => {
    await connection.connect('sensor'); const lease = connection.attachClient().journal(); const batch = await packet(lease);
    const commit = deferred(); const persisted = vi.fn(() => commit.promise); replyAck = false;
    const pending = lease.commitAndAcknowledge(batch.token, ackFor(batch), persisted);
    await vi.waitFor(() => expect(persisted).toHaveBeenCalled());
    await expect(lease.fetch(1n, 100)).rejects.toThrow('progress');
    expect(commands.filter(m => m.type === 4)).toHaveLength(0);
    commit.resolve(); await vi.waitFor(() => expect(commands.filter(m => m.type === 4)).toHaveLength(1));
    emit({ type: 0x87, requestId: 60000, batchId: ackFor(batch).batchId });
    await expect(lease.fetch(1n, 100)).rejects.toThrow('progress');
    emit({ type: 0x87, requestId: ackId, batchId: ackFor(batch).batchId }); await pending;
    expect((await packet(lease, 1n)).token.ticketId).not.toBe(batch.token.ticketId);
    lease.revoke(); await connection.disconnect();
  });

  it('waits for the entire ACK write even when ACK_ACCEPTED arrives before the write promise', async () => {
    await connection.connect('sensor'); const lease = connection.attachClient().journal(); const batch = await packet(lease);
    const write = deferred(); ackWrite = write.promise; let completed = false;
    const pending = lease.commitAndAcknowledge(batch.token, ackFor(batch), async () => {}).then(() => { completed = true; });
    await vi.waitFor(() => expect(commands.filter(m => m.type === 4)).toHaveLength(1));
    expect(completed).toBe(false); await expect(lease.fetch(1n, 100)).rejects.toThrow('progress');
    write.resolve(); await pending; expect(completed).toBe(true); lease.release();
  });

  it('revokes a pending commit immediately and rejects late completion/tokens after a new generation', async () => {
    await connection.connect('sensor'); const client = connection.attachClient(); const lease = client.journal(); const batch = await packet(lease);
    const gate = deferred(); const commit = vi.fn(() => gate.promise);
    const pending = lease.commitAndAcknowledge(batch.token, ackFor(batch), commit); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(commit).toHaveBeenCalled()); client.revoke(); await rejected; await connection.disconnect();
    expect(commands.filter(m => m.type === 4)).toHaveLength(0);
    await connection.connect('sensor'); const next = connection.attachClient().journal(); const fresh = await packet(next);
    expect(next.token.generation).not.toBe(lease.token.generation);
    gate.resolve(); await Promise.resolve(); await lease.close(); lease.release();
    await expect(next.commitAndAcknowledge(batch.token, ackFor(batch), async () => {})).rejects.toThrow('token');
    expect(connection.state()).toBe('ready'); expect(commands.filter(m => m.type === 4)).toHaveLength(0);
    await next.commitAndAcknowledge(fresh.token, ackFor(fresh), async () => {}); next.release();
  });

  it.each(['lease', 'client', 'release'] as const)('closes an unsafe FETCH on %s revocation and ignores old callbacks', async kind => {
    await connection.connect('sensor'); const client = connection.attachClient(); const lease = client.journal(); holdFetch = true;
    const pending = lease.fetch(0n, 100); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(commands.some(m => m.type === 3)).toBe(true));
    const oldNotify = notify; const oldLost = lost;
    if (kind === 'client') client.revoke(); else if (kind === 'release') lease.release(); else lease.revoke();
    await rejected; await connection.disconnect(); expect(adapter.disconnect).toHaveBeenCalledOnce();
    holdFetch = false; await connection.connect('sensor');
    oldNotify(view(Uint8Array.of(0))); oldLost(); await lease.close();
    expect(connection.state()).toBe('ready'); expect(commands.filter(m => m.type === 4)).toHaveLength(0);
  });
});
