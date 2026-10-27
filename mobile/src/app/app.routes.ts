import { Routes } from '@angular/router';
import { CO2_SOURCE, createInactiveCo2Source } from './features/air-monitor/data-access/co2-source';
import { Co2History } from './features/air-monitor/data-access/co2-history';
import { Co2Storage } from './features/air-monitor/data-access/co2-storage';
import { Co2Monitor } from './features/air-monitor/data-access/co2-monitor';
import { BleScanner } from './features/air-monitor/data-access/ble-scanner';
import { BleConnection } from './features/air-monitor/data-access/ble-connection';
import { BLE_SESSION } from './features/air-monitor/data-access/ble-session';
import { BleJournalSync } from './features/air-monitor/data-access/ble-journal-sync';

export const routes: Routes = [
  {
    path: '',
    providers: [Co2History, Co2Storage, Co2Monitor, BleScanner, BleConnection, BleJournalSync,
      { provide: BLE_SESSION, useExisting: BleConnection },
      { provide: CO2_SOURCE, useFactory: createInactiveCo2Source }],
    pathMatch: 'full',
    loadComponent: () => import('./features/air-monitor/air-monitor-page').then(module => module.AirMonitorPage),
  },
];
