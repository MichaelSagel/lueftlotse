import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { CO2_SOURCE, createInactiveCo2Source } from './features/air-monitor/data-access/co2-source';
import { Co2History } from './features/air-monitor/data-access/co2-history';
import { Co2Storage } from './features/air-monitor/data-access/co2-storage';
import { Co2Monitor } from './features/air-monitor/data-access/co2-monitor';
import { BleScanner } from './features/air-monitor/data-access/ble-scanner';
import { NativeBleSession } from './features/air-monitor/data-access/native-ble-session';
import { BrowserBleSession } from './features/air-monitor/data-access/browser-ble-session';
import { ANDROID_BLE } from './features/air-monitor/data-access/ble-platform';
import { NativeBleBinding } from './features/air-monitor/data-access/native-ble-binding';
import { BLE_SERVICE_BINDING_BRIDGE } from './features/air-monitor/data-access/ble-service-binding-bridge';
import { BLE_SERVICE_SESSION_BRIDGE } from './features/air-monitor/data-access/ble-service-session-bridge';
import { BLE_SESSION } from './features/air-monitor/data-access/ble-session';
import { BleJournalSync } from './features/air-monitor/data-access/ble-journal-sync';

export const routes: Routes = [
  {
    path: '',
    providers: [Co2History, Co2Storage, Co2Monitor, BleScanner, NativeBleSession, NativeBleBinding, BrowserBleSession, BleJournalSync,
      { provide: BLE_SERVICE_BINDING_BRIDGE, useExisting: BLE_SERVICE_SESSION_BRIDGE },
      { provide: BLE_SESSION, useFactory: () => inject(ANDROID_BLE) ? inject(NativeBleSession) : inject(BrowserBleSession) },
      { provide: CO2_SOURCE, useFactory: createInactiveCo2Source }],
    pathMatch: 'full',
    loadComponent: () => import('./features/air-monitor/air-monitor-page').then(module => module.AirMonitorPage),
  },
];
