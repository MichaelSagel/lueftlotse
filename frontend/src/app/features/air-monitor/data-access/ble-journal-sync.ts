import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { BatchReceiver } from '../ble-protocol/batch-receiver';
import { BLE_SESSION, BleCommandError, BleJournalLease, BleSessionClosedError } from './ble-session';
import { Co2Storage } from './co2-storage';
import { Co2History } from './co2-history';

export type JournalResult = { status: 'complete' | 'time-required' | 'busy' | 'clock-invalid' | 'cancelled' | 'disconnected' | 'unsupported' | 'error'; cursor?: bigint; target?: bigint; message: string };

/** Explicit, finite catch-up only. Storage commits stay in IndexedDB. */
@Injectable()
export class BleJournalSync {
  private readonly connection = inject(BLE_SESSION);
  private readonly client = this.connection.attachClient();
  private readonly storage = inject(Co2Storage);
  private readonly history = inject(Co2History);
  readonly running = signal(false);
  /** READY entries durably verified this run, including identical existing records. */
  readonly savedMeasurements = signal(0);
  private active?: AbortController;
  constructor() { inject(DestroyRef).onDestroy(() => { this.cancel(); this.client.revoke(); }); }
  cancel(): void { this.active?.abort(new DOMException('Journal cancelled', 'AbortError')); }

  async run(signal?: AbortSignal): Promise<JournalResult> {
    if (this.running()) return { status: 'busy', message: 'Eine Übertragung läuft bereits.' };
    this.running.set(true); this.savedMeasurements.set(0);
    const controller = new AbortController(); this.active = controller;
    const cancel = () => controller.abort(new DOMException('Journal cancelled', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    let link: BleJournalLease | undefined; let receiver: BatchReceiver | undefined;
    let uncleared = () => {};
    const lost = () => { if (!controller.signal.aborted) controller.abort(link!.signal.reason); };
    const stopReceiver = () => receiver?.disconnect();
    controller.signal.addEventListener('abort', stopReceiver, { once: true });
    try {
      signal?.throwIfAborted();
      link = this.client.journal(controller.signal);
      const transport = link;
      transport.signal.addEventListener('abort', lost, { once: true });
      uncleared = this.storage.onHistoryCleared(() => controller.abort(new DOMException('History cleared', 'AbortError')));
      if (this.storage.historyClearing) throw new Error('History is being cleared');
      if ((transport.info.capabilities & 0x000a) !== 0x000a) return { status: 'unsupported', message: 'Das Gerät unterstützt die bestätigte Journalübertragung nicht.' };
      const status = await transport.getStatus();
      if (status.storageState !== 0) throw new Error('Device journal unavailable');
      if (!status.timeValid || status.firstUndated !== 0n) return { status: 'time-required', message: 'Die Gerätezeit muss zuerst synchronisiert werden.' };
      const target = status.latest;
      let cursor = await this.storage.bleCursor(transport.info.deviceId);
      if (cursor > target) throw new Error('Local cursor exceeds device journal');
      while (cursor < target) {
        controller.signal.throwIfAborted();
        const after = cursor;
        const packet = await transport.fetch(after, 100);
        if (packet.kind === 'time-pending') return { status: 'time-required', cursor, target, message: 'Die nächsten Messungen haben noch keine UTC-Zeit.' };
        if (packet.kind === 'status') {
          if (packet.status.latest !== after || after < target) throw new Error('Device journal ended before fixed target');
          break;
        }
        const begin = packet.messages[0];
        if (begin.type !== 0x82) throw new Error('Expected BATCH_BEGIN');
        const batchReady = packet.messages.filter(message => message.type === 0x83 && message.entry.tag === 1).length;
        receiver = new BatchReceiver(transport.info.deviceId, this.storage, {
          commitAndSend: (ack, commit, batchSignal) => transport.commitAndAcknowledge(packet.token, ack, async () => {
            controller.signal.throwIfAborted(); batchSignal.throwIfAborted();
            await commit();
            this.savedMeasurements.update(count => count + batchReady);
            await this.history.imported();
            controller.signal.throwIfAborted(); batchSignal.throwIfAborted();
          }),
        });
        for (const message of packet.messages) {
          controller.signal.throwIfAborted(); await receiver.receive(message);
        }
        await receiver.completion; receiver.dispose(); receiver = undefined;
        controller.signal.throwIfAborted();
        cursor = await this.storage.bleCursor(transport.info.deviceId);
        if (cursor <= after || cursor !== begin.throughSequence) throw new Error('Committed cursor did not advance to batch boundary');
      }
      controller.signal.throwIfAborted();
      return { status: 'complete', cursor, target, message: 'Verfügbare Journalmessungen wurden gespeichert.' };
    } catch (error) {
      const reason = controller.signal.reason;
      if (link) { link.signal.removeEventListener('abort', lost); await link.close().catch(() => {}); }
      if (error instanceof BleCommandError && error.code === 3) return { status: 'busy', message: 'Das Gerät ist beschäftigt. Später ausdrücklich erneut starten.' };
      if (error instanceof BleCommandError && error.code === 5) return { status: 'clock-invalid', message: 'Das Gerät hat die Zeit als ungültig gemeldet.' };
      if (signal?.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return { status: 'cancelled', message: 'Die Übertragung wurde abgebrochen.' };
      if (reason instanceof BleSessionClosedError || error instanceof BleSessionClosedError) return { status: 'disconnected', message: 'Die Verbindung wurde unterbrochen.' };
      return { status: 'error', message: 'Journalübertragung fehlgeschlagen. Bereits gespeicherte Messungen bleiben erhalten.' };
    } finally {
      uncleared(); receiver?.dispose();
      if (link) link.signal.removeEventListener('abort', lost);
      controller.signal.removeEventListener('abort', stopReceiver);
      signal?.removeEventListener('abort', cancel); link?.release();
      this.active = undefined; this.running.set(false);
    }
  }
}
