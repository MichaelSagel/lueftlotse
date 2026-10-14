import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { CO2_SOURCE } from './co2-source';
import { Co2Simulator } from './co2-simulator';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(), { provide: CO2_SOURCE, useExisting: Co2Simulator },
    provideRouter(routes)
  ]
};
