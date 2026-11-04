import { Component, effect, inject, signal } from '@angular/core';
import { Co2Sync } from '../../data-access/co2-sync';
import { Co2Storage } from '../../data-access/co2-storage';

@Component({
  selector: 'app-synchronization',
  providers: [Co2Sync],
  template: `
    <button type="button" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" aria-controls="measurement-sync">Synchronisierung</button>
    <section id="measurement-sync" [hidden]="!expanded()" aria-label="Messwerte synchronisieren">
      @if (sync.countsAvailable()) {
      <p>Ausstehend (pending): {{ sync.counts().pending }} · Synchronisiert (synced): {{ sync.counts().synced }}</p>
      }
      @if (!sync.endpoint) {
        <p>Server noch nicht eingerichtet. Für die Android-App wird eine eigene Serveradresse benötigt; localhost verweist auf das Telefon.</p>
      }
      <button type="button" (click)="sync.synchronize()" [disabled]="sync.running() || !sync.endpoint">Jetzt synchronisieren</button>
      @if (sync.running()) {
        <p role="status">Synchronisierung läuft: {{ sync.completed() }} / {{ sync.total() }}</p>
        <progress [value]="sync.completed()" [max]="sync.total() || 1" aria-label="Bestätigte Messungen"></progress>
      }
      @if (sync.result()) { <p role="status">{{ sync.result() }}</p> }
      @if (sync.error()) { <p role="alert">{{ sync.error() }}</p> }
      <p>Die lokale Historie bleibt erhalten. Neue Messungen während der Übertragung werden beim nächsten Start gesendet.</p>
    </section>
  `,
  styles: `
    :host { display: block; margin-bottom: 24px; }
    button { width: 100%; min-height: 48px; padding: 12px; margin-bottom: 8px; border: 1px solid #163e2c; border-radius: 14px; background: white; color: #163e2c; font: inherit; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .6; cursor: default; }
    button:focus-visible { outline: 3px solid #17663e; outline-offset: 3px; }
    section { padding: 12px; border: 1px solid #b7cbc1; border-radius: 14px; font-size: 14px; line-height: 1.5; }
    progress { width: 100%; }
  `,
})
export class Synchronization {
  protected readonly sync = inject(Co2Sync);
  protected readonly expanded = signal(false);
  private readonly storage = inject(Co2Storage);
  constructor() {
    effect(() => {
      if (this.expanded()) {
        this.storage.changes();
        void this.sync.refreshCounts();
      }
    });
  }
}
