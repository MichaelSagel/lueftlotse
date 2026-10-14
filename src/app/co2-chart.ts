import { Component, computed, inject } from '@angular/core';
import { Co2History } from './co2-history';

@Component({ selector: 'app-co2-chart', templateUrl: './co2-chart.html', styleUrl: './co2-chart.scss' })
export class Co2Chart {
  protected readonly history = inject(Co2History);
  private readonly formatter = new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  protected readonly chart = computed(() => {
    const entries = this.history.measurements();
    if (!entries.length) return null;
    const first = entries[0].time;
    const last = entries[entries.length - 1].time;
    const min = Math.floor(Math.min(...entries.map(entry => entry.ppm)) / 100) * 100;
    const max = Math.max(min + 100, Math.ceil(Math.max(...entries.map(entry => entry.ppm)) / 100) * 100);
    const points = entries.map(entry => ({
      ...entry,
      x: last === first ? 184 : 48 + (entry.time - first) / (last - first) * 272,
      y: 148 - (entry.ppm - min) / (max - min) * 120,
      label: `${this.formatter.format(entry.time)}: ${entry.ppm} ppm`,
    }));
    const segments: string[] = [];
    points.forEach((point, index) => {
      const coordinate = `${point.x},${point.y}`;
      if (index === 0 || point.segment !== points[index - 1].segment) segments.push(coordinate);
      else segments[segments.length - 1] += ` ${coordinate}`;
    });
    return { points, segments, min, max, first: this.formatter.format(first), last: this.formatter.format(last) };
  });
}
