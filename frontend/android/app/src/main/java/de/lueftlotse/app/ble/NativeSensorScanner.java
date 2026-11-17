package de.lueftlotse.app.ble;

import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.Context;
import android.os.ParcelUuid;
import de.lueftlotse.ble.Codec;
import java.util.*;
import java.util.function.Consumer;

/** Used only while the native service owns BLE admission; no plugin/WebView scanner. */
final class NativeSensorScanner {
    private final Context context;
    private BluetoothLeScanner scanner;
    private ScanCallback callback;
    private static final ParcelUuid SERVICE = ParcelUuid.fromString(Codec.SERVICE);

    NativeSensorScanner(Context context) { this.context = context; }

    void start(Consumer<ServiceDiscovery.Candidate> found, Consumer<String> failed) {
        if (callback != null) {
            throw new IllegalStateException("Scan already active");
        }
        if (!BleServiceRuntime.discoveryPermitted(context)) {
            throw new SecurityException("BLE scan permission missing");
        }
        BluetoothManager manager = context.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        scanner = adapter == null ? null : adapter.getBluetoothLeScanner();
        if (scanner == null) {
            failed.accept("Bluetooth ist ausgeschaltet");
            return;
        }
        callback = new ScanCallback() {
            @Override public void onScanResult(int type, ScanResult result) {
                ScanRecord record = result.getScanRecord();
                if (record == null || record.getServiceUuids() == null || !record.getServiceUuids().contains(SERVICE)) {
                    return;
                }
                ServiceDiscovery.Candidate candidate = new ServiceDiscovery.Candidate(
                    result.getDevice().getAddress(), record.getDeviceName()
                );
                BleServiceRuntime.MAIN.post(() -> {
                    if (callback == this) {
                        found.accept(candidate);
                    }
                });
            }
            @Override public void onScanFailed(int code) {
                BleServiceRuntime.MAIN.post(() -> {
                    if (callback == this) {
                        failed.accept("Scan failed: " + code);
                    }
                });
            }
        };
        android.util.Log.i("SensorDiscovery", "SCAN_START service=" + Codec.SERVICE);
        scanner.startScan(Collections.singletonList(new ScanFilter.Builder().setServiceUuid(SERVICE).build()),
            new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback);
    }
    void stop() {
        if (callback == null) {
            return;
        }
        scanner.stopScan(callback);
        callback = null;
        scanner = null;
        android.util.Log.i("SensorDiscovery", "SCAN_STOP");
    }
}
