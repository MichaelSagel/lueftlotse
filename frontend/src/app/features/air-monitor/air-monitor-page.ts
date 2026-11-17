import { ANDROID_BLE } from './data-access/ble-platform';
import { BLE_SESSION } from './data-access/ble-session';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal
} from '@angular/core';
import { Co2Monitor } from './data-access/co2-monitor';
import { co2Status } from './domain/co2-status';
import { Co2History } from './data-access/co2-history';
import { DeviceDiscovery } from './components/device-discovery/device-discovery';
import { ServerHistoryBlock } from './components/server-history/server-history';

@Component({
  selector: 'app-air-monitor-page',
  imports: [DeviceDiscovery, ServerHistoryBlock],
  styleUrl: './air-monitor-page.scss',
  templateUrl: './air-monitor-page.html'
})
export class AirMonitorPage {
  protected readonly android = inject(ANDROID_BLE);
  private readonly session = inject(BLE_SESSION);
  private readonly connectionClient = this.android ? this.session.attachClient() : null;
  private pullStart: { x: number; y: number } | null = null;
  private refreshing = false;
  protected readonly pullProgress = signal(0);
  private readonly pullWaiting = signal(false);
  private readonly pullRequestPending = signal(false);
  protected readonly pullSpinning = computed(() => this.pullWaiting() && (
    this.pullRequestPending() || this.session.state() === 'connecting' || this.session.reconnecting?.() === true
  ));
  protected readonly pullVisible = computed(() => this.pullProgress() > 0 || this.pullSpinning());
  protected readonly pullHeight = computed(() => this.pullSpinning() ? 44 : this.pullProgress() * 44);
  protected readonly searching = computed(() => this.android && this.session.discoveryMode?.() === 'searching');
  protected readonly source = inject(Co2Monitor);
  // Keep existing local storage initialization/retention while its UI is hidden.
  protected readonly history = inject(Co2History);
  constructor() {
    inject(DestroyRef).onDestroy(() => this.connectionClient?.revoke());
    effect(() => {
      if (this.pullWaiting() && !this.pullSpinning()) {
        this.pullWaiting.set(false);
      }
    });
  }

  protected startPull(event: TouchEvent): void {
    this.pullStart = null;
    this.pullProgress.set(0);
    if (!this.android || event.touches.length !== 1 || window.scrollY > 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('input, button, select, textarea, dialog')) {
      return;
    }
    const touch = event.touches[0];
    this.pullStart = { x: touch.clientX, y: touch.clientY };
  }

  protected movePull(event: TouchEvent): void {
    const start = this.pullStart;
    if (!start) {
      return;
    }
    if (event.touches.length !== 1) {
      this.cancelPull();
      return;
    }
    const touch = event.touches[0];
    const distance = touch.clientY - start.y;
    this.pullProgress.set(distance > 0 && Math.abs(touch.clientX - start.x) <= distance / 2
      ? Math.min(distance / 80, 1)
      : 0);
  }

  protected cancelPull(): void {
    this.pullStart = null;
    this.pullProgress.set(0);
  }

  protected async finishPull(event: TouchEvent): Promise<void> {
    const start = this.pullStart;
    this.pullStart = null;
    this.pullProgress.set(0);
    if (!start || this.refreshing || event.touches.length || event.changedTouches.length !== 1) {
      return;
    }
    const touch = event.changedTouches[0];
    const distance = touch.clientY - start.y;
    if (distance < 80 || Math.abs(touch.clientX - start.x) > distance / 2) {
      return;
    }
    this.refreshing = true;
    this.pullRequestPending.set(true);
    this.pullWaiting.set(true);
    try {
      // Native session retains an active run and serializes startup when idle.
      await this.connectionClient?.connectAutomatically?.();
    } catch {
      // NativeBleSession exposes connection/permission errors through BLE_SESSION.
    } finally {
      this.refreshing = false;
      this.pullRequestPending.set(false);
    }
  }
  protected readonly status = computed(() => {
    const reading = this.source.current();
    if (!reading) return {
      color: 'unavailable',
      label: this.source.sensorState() === 'waiting'
        ? 'Noch keine Messung'
        : 'Sensor nicht verfügbar',
      hint: this.source.sensorText(),
    };
    return co2Status(reading.ppm);
  });
}
