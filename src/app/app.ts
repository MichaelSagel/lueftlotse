import { Component, inject } from '@angular/core';
import { Co2Simulator } from './co2-simulator';

@Component({ selector: 'app-root', styleUrl: './app.scss', templateUrl: './app.html' })
export class App {
  protected readonly simulator = inject(Co2Simulator);
}
