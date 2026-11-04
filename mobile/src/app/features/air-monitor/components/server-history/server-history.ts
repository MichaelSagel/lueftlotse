import { ANDROID_BLE } from '../../data-access/ble-platform';
import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { HistorySort, ServerHistory } from '../../data-access/server-history';

function localInput(time: number): string {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
@Component({
  selector: 'app-server-history', imports: [DatePipe], providers: [ServerHistory],
  template: `
    @if (android) {
    <button type="button" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()" aria-controls="server-history">Serververlauf</button>
    }
    <section id="server-history" [hidden]="android && !expanded()" aria-label="Serververlauf">
      <div class="period-filter">
      <label>Von <input type="datetime-local" [value]="from()" (input)="from.set($any($event.target).value); changed()"></label>
      <label>Bis <input type="datetime-local" [value]="to()" (input)="to.set($any($event.target).value); changed()"></label>
      </div>
      <button type="button" (click)="history.load()" [disabled]="history.loading()">{{ android ? 'Laden' : 'Verlauf anzeigen' }}</button>
      @if (history.loading()) { <p role="status">Serververlauf wird geladen …</p> }
      @if (history.error(); as error) { <p role="alert">{{ error }}</p> }
      @if (history.loaded() && !history.rows().length && !history.loading()) { <p role="status">Keine Messungen für diesen Zeitraum gefunden.</p> }
      @if (history.rows().length) {
        <div class="table-scroll"><table [class.browser-history]="!android">
          @if (android) { <caption>Servermessungen · lokale Zeit</caption> }
          <thead><tr>
            @if (android) { <th>Zeit</th><th>CO₂ (ppm)</th> } @else {
              <th [attr.aria-sort]="sort().startsWith('time-') ? (sort() === 'time-desc' ? 'descending' : 'ascending') : 'none'">
                <button class="sort" type="button" (click)="sortBy('time')">Zeit{{ sort().startsWith('time-') ? (sort() === 'time-desc' ? ' ↓' : ' ↑') : '' }}</button>
              </th>
              <th [attr.aria-sort]="sort().startsWith('ppm-') ? (sort() === 'ppm-desc' ? 'descending' : 'ascending') : 'none'">
                <button class="sort" type="button" (click)="sortBy('ppm')">CO₂ (ppm){{ sort().startsWith('ppm-') ? (sort() === 'ppm-desc' ? ' ↓' : ' ↑') : '' }}</button>
              </th>
            }
            @if (android) { <th>Quelle</th> }</tr></thead>
          <tbody>@for (row of history.rows(); track row.measurementId) {
            <tr><td>{{ row.measuredAt | date:'dd.MM.yyyy HH:mm:ss' }}</td><td>{{ row.ppm }}</td>@if (android) { <td>{{ row.source }}</td> }</tr>
          }</tbody></table></div>
      }
      @if (history.nextCursor()) { <button type="button" (click)="history.load(true)" [disabled]="history.loading()">Weitere laden</button> }
    </section>
  `,
  styles: `
    :host { display:block; min-width:0; margin-bottom:24px; }
    button,input { font:inherit; padding:10px; margin:4px 0; max-width:100%; min-height:48px; box-sizing:border-box; }
    button { width:100%; border:1px solid #163e2c; border-radius:14px; background:white; color:#163e2c; font-weight:600; cursor:pointer; }
    button:disabled { opacity:.6; cursor:default; }
    button:focus-visible,input:focus-visible { outline:3px solid #17663e; outline-offset:3px; }
    label { display:grid; min-width:0; font-size:14px; }
    input { width:100%; min-width:0; border:1px solid #b7cbc1; border-radius:8px; background:white; color:#193629; }
    section { padding:16px; border:1px solid #b7cbc1; border-radius:14px; background:white; overflow-wrap:anywhere; }
    .period-filter { display:grid; gap:12px; }
    .table-scroll { width:100%; min-width:0; overflow-x:auto; }
    table { width:100%; table-layout:fixed; border-collapse:collapse; font-variant-numeric:tabular-nums; }
    caption { text-align:left; padding:12px 0; color:#52675e; }
    th,td { padding:10px 6px; text-align:left; overflow-wrap:anywhere; border-bottom:1px solid #e4f3e9; }
    button.sort { border:0; border-radius:0; background:transparent; text-align:left; padding:0; margin:0; }
    th:first-child { width:46%; }
    .browser-history th { width:50%; }
    .browser-history th, .browser-history td { white-space:normal; overflow-wrap:anywhere; }
    .browser-history th, .browser-history td, .browser-history th button.sort { text-align:center; }
    @media (min-width:600px) { .period-filter { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  `,
})
export class ServerHistoryBlock {
  protected readonly android = inject(ANDROID_BLE);
  protected readonly history = inject(ServerHistory);
  protected readonly sort = signal<HistorySort>('time-desc');
  protected sortBy(column: 'time' | 'ppm'): void {
    this.sort.set(this.sort() === `${column}-desc` ? `${column}-asc` : `${column}-desc`);
    this.changed();
    void this.history.load();
  }
  protected readonly expanded = signal(false);
  protected readonly from = signal(localInput(Date.now() - 86400000));
  protected readonly to = signal(localInput(Date.now()));
  constructor() { this.changed(); }
  protected changed(): void { this.history.setFilters({ from: this.from(), to: this.to(), deviceId: '', ...(this.android ? {} : { sort: this.sort() }) }); }
}
