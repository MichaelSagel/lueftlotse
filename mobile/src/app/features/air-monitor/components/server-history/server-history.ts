import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { ServerHistory } from '../../data-access/server-history';

function localInput(time: number): string {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
@Component({
  selector: 'app-server-history', imports: [DatePipe], providers: [ServerHistory],
  template: `
    <button type="button" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" aria-controls="server-history">Serververlauf</button>
    <section id="server-history" [hidden]="!expanded()" aria-label="Serververlauf">
      <p>Messungen aus PostgreSQL. Dieser Verlauf ist unabhängig vom lokalen Verlauf.</p>
      <label>Von (lokale Zeit) <input type="datetime-local" [value]="from()" (input)="from.set($any($event.target).value); changed()"></label>
      <label>Bis (ausschließlich, lokale Zeit) <input type="datetime-local" [value]="to()" (input)="to.set($any($event.target).value); changed()"></label>
      <button type="button" (click)="history.load()" [disabled]="history.loading()">Laden</button>
      @if (history.loading()) { <p role="status">Serververlauf wird geladen …</p> }
      @if (history.error(); as error) { <p role="alert">{{ error }}</p> }
      @if (history.loaded() && !history.rows().length && !history.loading()) { <p role="status">Keine Messungen für diesen Zeitraum gefunden.</p> }
      @if (history.rows().length) {
        <div class="table-scroll"><table><caption>Servermessungen · lokale Zeit</caption>
          <thead><tr><th>Zeit</th><th>CO₂ (ppm)</th><th>Quelle</th></tr></thead>
          <tbody>@for (row of history.rows(); track row.measurementId) {
            <tr><td>{{ row.measuredAt | date:'dd.MM.yyyy HH:mm:ss' }}</td><td>{{ row.ppm }}</td><td>{{ row.source }}</td></tr>
          }</tbody></table></div>
      }
      @if (history.nextCursor()) { <button type="button" (click)="history.load(true)" [disabled]="history.loading()">Weitere laden</button> }
    </section>
  `,
  styles: `:host { display:block; min-width:0; margin-bottom:24px; } button,input { font:inherit; padding:10px; margin:4px 0; max-width:100%; box-sizing:border-box; } label { display:block; } section { padding:12px; border:1px solid #b7cbc1; border-radius:14px; } .table-scroll { width:100%; min-width:0; } table { width:100%; table-layout:fixed; border-collapse:collapse; } th,td { padding:6px 4px; text-align:left; overflow-wrap:anywhere; } th:first-child { width:46%; }`,
})
export class ServerHistoryBlock {
  protected readonly history = inject(ServerHistory);
  protected readonly expanded = signal(false);
  protected readonly from = signal(localInput(Date.now() - 86400000));
  protected readonly to = signal(localInput(Date.now()));
  constructor() { this.changed(); }
  protected changed(): void { this.history.setFilters({ from: this.from(), to: this.to(), deviceId: '' }); }
}
