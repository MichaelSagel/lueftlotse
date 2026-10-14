import { Component, inject } from '@angular/core';
import { Co2Simulator } from './co2-simulator';
import { Co2Chart } from './co2-chart';

@Component({ selector: 'app-root', imports: [Co2Chart], styleUrl: './app.scss', templateUrl: './app.html' })
export class App {
  protected readonly simulator = inject(Co2Simulator);
}
