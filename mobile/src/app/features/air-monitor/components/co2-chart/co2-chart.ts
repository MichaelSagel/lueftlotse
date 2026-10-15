import { Component, computed, inject, signal } from '@angular/core';
import { Co2History, HistoryPeriod } from '../../data-access/co2-history';
import { retentionStart } from '../../domain/history-range';

function localInput(time: number): string {
  const date = new Date(time);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

@Component({ selector: 'app-co2-chart', templateUrl: './co2-chart.html', styleUrl: './co2-chart.scss' })
export class Co2Chart {
  protected readonly history = inject(Co2History);
  protected readonly startInput = signal(localInput(this.history.range().start));
  protected readonly endInput = signal(localInput(this.history.range().end));
  protected minimumDate(): string { return localInput(retentionStart(Date.now())); }
  protected maximumDate(): string { return localInput(Date.now()); }
  protected readonly periods: { value: HistoryPeriod; label: string }[] = [
    { value: '5m', label: '5 Min.' }, { value: '1h', label: '1 Std.' },
    { value: '24h', label: '24 Std.' }, { value: '1w', label: '1 Woche' },
    { value: '1mo', label: '1 Monat' }, { value: '1y', label: '1 Jahr' },
    { value: '2y', label: '2 Jahre' }, { value: 'custom', label: 'Benutzerdefiniert' },
  ];
  private readonly dateFormatter = new Intl.DateTimeFormat('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' });
  private readonly timeFormatter = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  protected date(time: number): string { return this.dateFormatter.format(time); }
  protected time(time: number): string { return this.timeFormatter.format(time); }
  protected fullTime(time: number): string { return `${this.date(time)} ${this.time(time)}`; }
  protected choosePeriod(period: HistoryPeriod): void { this.history.choosePeriod(period); this.syncInputs(); }
  protected navigate(direction: -1 | 1): void { this.history.navigate(direction); this.syncInputs(); }
  protected now(): void { this.history.now(); this.syncInputs(); }
  private syncInputs(): void {
    this.startInput.set(localInput(this.history.range().start)); this.endInput.set(localInput(this.history.range().end));
  }
  protected applyRange(): void {
    const parse = (value: string) => {
      const date = new Date(value);
      // Reject invalid dates normalized by Date, including nonexistent local DST times.
      return Number.isFinite(date.getTime()) && localInput(date.getTime()) === (value.length === 16 ? value + ':00' : value) ? date.getTime() : NaN;
    };
    this.history.selectRange(parse(this.startInput()), parse(this.endInput()));
  }
  protected previousDisabled(): boolean { return this.history.range().start <= retentionStart(Date.now()); }
  protected nextDisabled(): boolean { return this.history.range().end >= Date.now() - 1000; }
  protected deleteHistory(): void {
    if (window.confirm('Gesamten gespeicherten Verlauf unwiderruflich löschen? Die Simulation läuft weiter.')) void this.history.clear();
  }
  protected readonly chart = computed(() => {
    const entries = this.history.measurements();
    if (!entries.length) return null;
    const firstTime = entries[0].time;
    const lastTime = entries[entries.length - 1].time;
    const min = Math.floor(Math.min(...entries.map(entry => entry.ppm)) / 100) * 100;
    const max = Math.max(min + 100, Math.ceil(Math.max(...entries.map(entry => entry.ppm)) / 100) * 100);
    const points = entries.map(entry => ({
      ...entry,
      x: firstTime === lastTime ? 184 : 48 + (entry.time - firstTime) / (lastTime - firstTime) * 272,
      y: 148 - (entry.ppm - min) / (max - min) * 120,
      label: `${this.fullTime(entry.time)}: ${entry.ppm} ppm`,
    }));
    const segments: string[] = [];
    points.forEach((point, index) => {
      const coordinate = `${point.x},${point.y}`;
      if (index === 0 || point.segment !== points[index - 1].segment) segments.push(coordinate);
      else segments[segments.length - 1] += ` ${coordinate}`;
    });
    return { points, segments, min, max, first: this.time(firstTime), last: this.time(lastTime),
      multiDay: this.date(firstTime) !== this.date(lastTime), firstDate: this.date(firstTime), lastDate: this.date(lastTime),
      firstTime, lastTime, singleTime: firstTime === lastTime };
  });
}
