import { InjectionToken } from '@angular/core';
import { Capacitor } from '@capacitor/core';

export const ANDROID_BLE = new InjectionToken<boolean>('ANDROID_BLE', {
  providedIn: 'root', factory: () => Capacitor.getPlatform() === 'android',
});
