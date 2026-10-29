import { InjectionToken } from '@angular/core';
import { PluginListenerHandle } from '@capacitor/core';
import { decodeBody, encodeBody, Message } from '../ble-protocol/codec';
import { uuidBytes } from '../ble-protocol/binary';
import { BleServiceBindingBridge, nativeBindingBridge } from './ble-service-binding-bridge';

export interface NativeJournalToken { runId: string; generation: string; clientId: string; leaseId: string; }
export interface NativeJournalEvent {
  kind: 'BEGIN' | 'ENTRY' | 'END' | 'REVOKED'; token: NativeJournalToken;
  operationId?: string; ticketId?: string; message?: unknown; reason?: string;
}
export interface NativeJournalReply { kind: 'status' | 'time-pending' | 'batch' | 'ack-accepted' | 'error'; message?: unknown; ticketId?: string; }
export interface NativeAck { batchId: string; throughSequence: string; count: number; digest: string; }
export interface NativeCommitInput { token: NativeJournalToken; ticketId: string; ack: NativeAck; }
export interface NativeServiceState {
  state: 'stopped' | 'starting' | 'connecting' | 'ready' | 'stopping' | 'error';
  runId: string | null; info: unknown; status: unknown; lastSample: unknown;
  sampleAvailable: boolean; nowElapsedMs: string; reason: string | null; bindingError: string | null;
  permissionsGranted: boolean;
}
export interface BleServiceSessionBridge extends BleServiceBindingBridge {
  getState(): Promise<NativeServiceState>;
  start(input: { bleAddress: string; expectedDeviceId?: string }): Promise<NativeServiceState>;
  disconnect(input: { runId?: string; revision?: string }): Promise<NativeServiceState>;
  requestPermissions(): Promise<NativeServiceState>;
  closeSession(input: { runId: string }): Promise<NativeServiceState>;
  journalAcquire(input: { runId: string }): Promise<{ token: NativeJournalToken }>;
  journalStatus(input: { token: NativeJournalToken }): Promise<NativeJournalReply>;
  journalFetch(input: { token: NativeJournalToken; operationId: string; afterSequence: string; limit: number }): Promise<NativeJournalReply>;
  journalBeginCommit(input: NativeCommitInput): Promise<{ commitToken: string }>;
  journalCommitted(input: NativeCommitInput & { commitToken: string; committed: true }): Promise<NativeJournalReply>;
  journalHeartbeat(input: { token: NativeJournalToken }): Promise<void>;
  journalRevoke(input: { token: NativeJournalToken }): Promise<void>;
  addListener(name: 'journalEvent', receive: (event: NativeJournalEvent) => void): Promise<PluginListenerHandle>;
}
export const BLE_SERVICE_SESSION_BRIDGE = new InjectionToken<BleServiceSessionBridge>('BLE_SERVICE_SESSION_BRIDGE', {
  // One Capacitor proxy for both contracts; the native plugin implements all session methods.
  providedIn: 'root', factory: () => nativeBindingBridge as BleServiceSessionBridge,
});
export function nativeUint64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) throw new Error('Expected uint64 decimal string');
  return BigInt(value);
}
export function nativeToken(token: NativeJournalToken): NativeJournalToken {
  if (!token || typeof token !== 'object') throw new Error('Invalid journal token');
  const { runId, generation, clientId, leaseId } = token;
  for (const id of [runId, generation, clientId, leaseId]) uuidBytes(id);
  return Object.freeze({ runId, generation, clientId, leaseId });
}
export function sameNativeToken(a: NativeJournalToken, b: NativeJournalToken | undefined): boolean {
  return !!b && a.runId === b.runId && a.generation === b.generation && a.clientId === b.clientId && a.leaseId === b.leaseId;
}
const uint64Fields = new Set(['sequence', 'fromSequence', 'toSequence', 'afterSequence', 'throughSequence', 'uptimeMs', 'sampleCounter', 'oldest', 'latest', 'overwrittenThrough', 'firstUndated']);
/** Decode the JSON boundary, then apply the existing exact codec validation. */
export function nativeMessage(value: unknown): Message {
  const convert = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid bridge message');
    const result: Record<string, unknown> = { ...input };
    for (const [key, item] of Object.entries(result)) {
      if (uint64Fields.has(key)) result[key] = nativeUint64(item);
      else if (key === 'utcMs') {
        if (typeof item !== 'string' || !/^(0|-?[1-9][0-9]{0,18})$/.test(item)) throw new Error('Invalid UTC decimal string');
        result[key] = BigInt(item);
      } else if (key === 'entry') result[key] = convert(item);
      else if (key === 'digest') {
        if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) throw new Error('Invalid digest');
        result[key] = Uint8Array.from(item.match(/../g)!, byte => parseInt(byte, 16));
      }
    }
    return result;
  };
  const message = convert(value) as Message;
  return decodeBody(message.type, encodeBody(message));
}
export function nativeAck(ack: Extract<Message, {type: 4}>): NativeAck {
  encodeBody(ack);
  return { batchId: ack.batchId, throughSequence: ack.throughSequence.toString(), count: ack.count,
    digest: Array.from(ack.digest, byte => byte.toString(16).padStart(2, '0')).join('') };
}
