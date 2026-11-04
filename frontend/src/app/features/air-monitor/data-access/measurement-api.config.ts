import { InjectionToken } from '@angular/core';
import { nativeApi } from './native-api';

export interface MeasurementApiConfig { browserBaseUrl: string; nativeBaseUrl: string | null; usbDebug?: boolean; }

/** Browser /api uses the Angular dev proxy. Native has no server configured yet. */
export const MEASUREMENT_API_CONFIG = new InjectionToken<MeasurementApiConfig>('Measurement API config', {
  providedIn: 'root',
  factory: () => ({ browserBaseUrl: '/api', ...nativeApi }),
});
