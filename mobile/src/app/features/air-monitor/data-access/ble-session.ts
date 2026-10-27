import { InjectionToken, Signal } from '@angular/core';
import { Observable } from 'rxjs';
import { Info, Message } from '../ble-protocol/codec';
import { BatchAck, BatchMessage } from '../ble-protocol/batch-receiver';
import { BleBinding } from './ble-binding-storage';

export type BleStatus = Extract<Message, { type: 0x80 }>;
export type LiveSample = Extract<Message, { type: 0x8a }>;
export type PreviewEvent = { kind: 'ready' } | { kind: 'unavailable' } | { kind: 'sample'; sample: LiveSample };
export type BleState = 'idle' | 'connecting' | 'ready' | 'closing' | 'error';
export type BlePhase = Exclude<BleState, 'connecting'> | 'scan-stop' | 'initialize' | 'connect' | 'info' | 'subscribe' | 'status';
export class BleCommandError extends Error {
  constructor(readonly code: number) { super('BLE protocol error ' + code); }
}
export class BleSessionClosedError extends Error {}
export interface JournalToken {
  readonly generation: string;
  readonly clientId: string;
  readonly leaseId: string;
}
export interface BatchToken extends JournalToken { readonly ticketId: string; }
export type JournalFetch =
  | { readonly kind: 'batch'; readonly token: BatchToken; readonly messages: readonly BatchMessage[] }
  | { readonly kind: 'status'; readonly status: BleStatus }
  | { readonly kind: 'time-pending' };

/** One exclusive download. No raw writes or independently callable ACK escape this boundary. */
export interface BleJournalLease {
  readonly token: JournalToken;
  readonly info: Info;
  readonly signal: AbortSignal;
  getStatus(): Promise<BleStatus>;
  fetch(afterSequence: bigint, limit: number): Promise<JournalFetch>;
  /** commit must resolve only after atomic storage transaction completion and honor signal. */
  commitAndAcknowledge(token: BatchToken, ack: BatchAck, commit: () => Promise<void>): Promise<void>;
  /** Revocation rejects pending work; unsafe cancellation closes the captured connection. */
  revoke(): void;
  close(): Promise<void>;
  release(): void;
}

/** A command capability, not a GATT connection. Revoked clients cannot issue new commands. */
export interface BleSessionClient {
  readonly id: string;
  readonly signal: AbortSignal;
  connect(address: string): Promise<BleStatus>;
  disconnect(): Promise<void>;
  disconnectByUser(): Promise<void>;
  forgetDevice(): Promise<void>;
  journal(signal?: AbortSignal): BleJournalLease;
  revoke(): void;
}

export interface BleSession {
  readonly state: Signal<BleState>;
  readonly phase: Signal<BlePhase>;
  readonly info: Signal<Info | null>;
  readonly status: Signal<BleStatus | null>;
  readonly error: Signal<string | null>;
  readonly binding: Signal<BleBinding | null>;
  readonly bindingError: Signal<string | null>;
  readonly bindingLoading: Signal<boolean>;
  readonly previewEvents: Observable<PreviewEvent>;
  attachClient(): BleSessionClient;
}

/** Provided with useExisting: BleConnection at the application route. */
export const BLE_SESSION = new InjectionToken<BleSession>('BLE_SESSION');
