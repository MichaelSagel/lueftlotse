import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { BatchReceiver, BatchMessage } from '../ble-protocol/batch-receiver';
import { BleCommandError, BleConnection, BleJournalLink } from './ble-connection';
import { Co2Storage } from './co2-storage';
import { Co2History } from './co2-history';

export type JournalResult = { status: 'complete' | 'time-required' | 'busy' | 'clock-invalid' | 'cancelled' | 'disconnected' | 'unsupported' | 'error'; cursor?: bigint; target?: bigint; message: string };

/** Explicit, finite catch-up only. Not provided in UI and never changes Co2Source. */
@Injectable()
export class BleJournalSync {
  private readonly connection = inject(BleConnection);
  private readonly storage = inject(Co2Storage);
  private readonly history = inject(Co2History);
  readonly running = signal(false);
  private active?: AbortController;
  constructor() { inject(DestroyRef).onDestroy(() => this.cancel()); }
  cancel(): void { this.active?.abort(new DOMException('Journal cancelled','AbortError')); }

  async run(signal?: AbortSignal): Promise<JournalResult> {
    if (this.running()) return {status:'busy',message:'Eine Übertragung läuft bereits.'};
    this.running.set(true);
    const controller = new AbortController(); this.active = controller;
    const cancel = () => controller.abort(new DOMException('Journal cancelled','AbortError'));
    signal?.addEventListener('abort',cancel,{once:true});
    let link: BleJournalLink | undefined; let receiver: BatchReceiver | undefined;
    let unlisten = () => {}; let uncleared = () => {}; let disconnected = false;
    const lost = () => { disconnected = true; controller.abort(new Error('BLE disconnected')); };
    try {
      signal?.throwIfAborted();
      link = this.connection.journal();
      const transport = link;
      transport.signal.addEventListener('abort',lost,{once:true});
      uncleared = this.storage.onHistoryCleared(() => controller.abort(new DOMException('History cleared','AbortError')));
      if (this.storage.historyClearing) throw new Error('History is being cleared');
      if ((transport.info.capabilities & 0x000A) !== 0x000A) return {status:'unsupported',message:'Das Gerät unterstützt die bestätigte Journalübertragung nicht.'};
      const status = await transport.request({type:1},[0x80],controller.signal);
      if (status.type !== 0x80) throw new Error('Expected STATUS');
      if (status.storageState !== 0) throw new Error('Device journal unavailable');
      // uncertaintyMs has no agreed estimator. Never guess or send automatic TIME_SET.
      if (!status.timeValid || status.firstUndated !== 0n) return {status:'time-required',message:'Die Gerätezeit muss zuerst synchronisiert werden.'};
      const target = status.latest;
      let cursor = await this.storage.bleCursor(transport.info.deviceId);
      if (cursor > target) throw new Error('Local cursor exceeds device journal');
      receiver = new BatchReceiver(transport.info.deviceId,this.storage,{
        send: async (ack,batchSignal) => {
          controller.signal.throwIfAborted(); batchSignal.throwIfAborted();
          // Commit has happened, even if the ACK response is subsequently lost.
          await this.history.imported();
          controller.signal.throwIfAborted(); batchSignal.throwIfAborted();
          const accepted = await transport.request(ack,[0x87],controller.signal);
          if (accepted.type !== 0x87 || accepted.batchId !== ack.batchId) throw new Error('Wrong ACK_ACCEPTED batchId');
          controller.signal.throwIfAborted(); batchSignal.throwIfAborted();
        },
      });
      const stopReceiver = () => receiver?.disconnect();
      controller.signal.addEventListener('abort',stopReceiver,{once:true});
      try {
        while (cursor < target) {
          controller.signal.throwIfAborted();
          const after = cursor; const limit = 100;
          let fetchId = -1; let begun = false; let queued = 0;
          let chain = Promise.resolve();
          let beginProcessed: Promise<void> | undefined;
          unlisten = transport.listen(message => {
            if (message.type !== 0x82 && message.type !== 0x83 && message.type !== 0x84) return;
            if (controller.signal.aborted) return;
            if (message.type === 0x82) {
              if (begun || message.requestId !== fetchId || message.afterSequence !== after || message.count > limit || message.throughSequence <= after) {
                controller.abort(new Error('BATCH_BEGIN does not match FETCH')); return;
              }
              begun = true;
            } else if (!begun) { controller.abort(new Error('Batch entry without BEGIN')); return; }
            // At most BEGIN + 100 entries + END, even during asynchronous digest/commit.
            if (++queued > 102) { controller.abort(new Error('Incoming batch queue full')); return; }
            chain = chain.then(async () => {
              controller.signal.throwIfAborted(); await receiver!.receive(message as BatchMessage);
            });
            if (message.type === 0x82) beginProcessed = chain;
            void chain.catch(error => controller.abort(error));
          });
          try {
            const first = await transport.request({type:3,afterSequence:after,limit},[0x82,0x85,0x80],controller.signal,id => { fetchId = id; });
            if (first.type === 0x85) return {status:'time-required',cursor,target,message:'Die nächsten Messungen haben noch keine UTC-Zeit.'};
            if (first.type === 0x80) {
              if (first.latest !== after) throw new Error('Unexpected FETCH end STATUS');
              if (after < target) throw new Error('Device journal ended before fixed target');
              break;
            }
            if (first.type !== 0x82 || !begun) throw new Error('Expected BATCH_BEGIN');
            // BEGIN is processed before obtaining completion; later notifications need not have arrived yet.
            await beginProcessed;
            await receiver.completion;
            await chain;
            controller.signal.throwIfAborted();
            cursor = await this.storage.bleCursor(transport.info.deviceId);
            if (cursor <= after || cursor !== first.throughSequence) throw new Error('Committed cursor did not advance to batch boundary');
          } finally { unlisten(); unlisten = () => {}; }
        }
        controller.signal.throwIfAborted();
        return {status:'complete',cursor,target,message:'Verfügbare Journalmessungen wurden gespeichert.'};
      } finally { controller.signal.removeEventListener('abort',stopReceiver); }
    } catch (error) {
      // No retries: a lost ACK may leave the remote snapshot active. Reconnect explicitly next time.
      const wasDisconnected = disconnected;
      const reason = controller.signal.reason;
      const cancelled = signal?.aborted || (reason instanceof DOMException && reason.name === "AbortError");
      if (link) { link.signal.removeEventListener("abort",lost); await link.close().catch(() => {}); }
      if (error instanceof BleCommandError && error.code === 3) return {status:'busy',message:'Das Gerät ist beschäftigt. Später ausdrücklich erneut starten.'};
      if (error instanceof BleCommandError && error.code === 5) return {status:'clock-invalid',message:'Das Gerät hat die Zeit als ungültig gemeldet.'};
      if (wasDisconnected || cancelled) return {status:wasDisconnected ? 'disconnected' : 'cancelled',message:wasDisconnected ? 'Die Verbindung wurde unterbrochen.' : 'Die Übertragung wurde abgebrochen.'};
      return {status:'error',message:'Journalübertragung fehlgeschlagen. Bereits gespeicherte Messungen bleiben erhalten.'};
    } finally {
      unlisten(); uncleared(); receiver?.dispose();
      if (link) link.signal.removeEventListener('abort',lost);
      signal?.removeEventListener('abort',cancel); link?.release();
      this.active = undefined; this.running.set(false);
    }
  }
}
