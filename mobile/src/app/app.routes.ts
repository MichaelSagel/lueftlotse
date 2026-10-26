import { Routes } from '@angular/router';
import { CO2_SOURCE } from './features/air-monitor/data-access/co2-source';
import { Co2Simulator } from './features/air-monitor/data-access/co2-simulator';
import { Co2History } from './features/air-monitor/data-access/co2-history';
import { Co2Storage } from './features/air-monitor/data-access/co2-storage';
import { Co2Monitor } from './features/air-monitor/data-access/co2-monitor';
import { BleScanner } from './features/air-monitor/data-access/ble-scanner';
import { BleConnection } from './features/air-monitor/data-access/ble-connection';
import { BleJournalSync } from './features/air-monitor/data-access/ble-journal-sync';

export const routes: Routes = [
  {
    path: '',
    providers: [Co2Simulator, Co2History, Co2Storage, Co2Monitor, BleScanner, BleConnection, BleJournalSync,
      { provide: CO2_SOURCE, useExisting: Co2Simulator }],
    pathMatch: 'full',
    loadComponent: () => import('./features/air-monitor/air-monitor-page').then(module => module.AirMonitorPage),
  },
];
