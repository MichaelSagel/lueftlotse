package de.lueftlotse.app.ble;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.io.IOException;
import java.util.Map;

/** Process session state and one native binding repository. No process/boot startup. */
public final class BleServiceRuntime {
    public static final BleOwnership OWNERSHIP = new BleOwnership();
    static final BleServiceState STATE = new BleServiceState(OWNERSHIP);
    static final Handler MAIN = new Handler(Looper.getMainLooper());
    static final String CHANNEL = "sensor_connection_v1";
    static SensorBleService host;
    private static NativeBindingRepository bindings;
    private static LiveSampleWriter liveSamples;
    private static Co2AlertMonitor co2Alerts;
    private BleServiceRuntime() { }

    static void onMain() { if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Service command outside main queue"); }
    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Sensor-Verbindung", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Status der Bluetooth-Verbindung zum Sensor"); channel.setSound(null, null);
            channel.enableVibration(false); channel.setShowBadge(false);
            context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }
    private static boolean grant(Context context, String permission) { return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }
    public static boolean permitted(Context context) {
        return ServicePermissionPolicy.canConnect(Build.VERSION.SDK_INT,
                grant(context, Manifest.permission.BLUETOOTH) && grant(context, Manifest.permission.BLUETOOTH_ADMIN),
                grant(context, "android.permission.BLUETOOTH_CONNECT"),
                grant(context, "android.permission.FOREGROUND_SERVICE"),
                grant(context, "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"));
    }
    static boolean notificationsPermitted(Context context, String channelId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        boolean notifications = manager != null && manager.areNotificationsEnabled();
        if (notifications && Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(channelId);
            notifications = channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        return ServicePermissionPolicy.canNotify(Build.VERSION.SDK_INT,
                grant(context, "android.permission.POST_NOTIFICATIONS"), notifications);
    }
    static Map<String, Object> snapshot() { onMain(); return STATE.snapshot(SystemClock.elapsedRealtime()); }
    static synchronized LiveSampleWriter liveSamples(Context context) {
        if (liveSamples == null) {
            Context application = context.getApplicationContext();
            liveSamples = new LiveSampleWriter(
                () -> new AndroidLiveSampleStore(application),
                (sample, error) -> {
                    String message = "LIVE_SAMPLE storage [" + sample.deviceId + "/" + sample.bootId
                        + "/" + sample.sampleCounter + "]: " + error;
                    STATE.liveStorageError(message);
                    android.util.Log.e("SensorBleService", message, error);
                }
            );
        }
        return liveSamples;
    }
    static synchronized Co2AlertMonitor co2Alerts(Context context) {
        if (co2Alerts == null) {
            Context application = context.getApplicationContext();
            AndroidCo2Notifications notifications = new AndroidCo2Notifications(application);
            co2Alerts = new Co2AlertMonitor(
                () -> new Co2AlertPolicy(new AndroidCo2AlertStore(application)),
                SystemClock::elapsedRealtime,
                notifications::allowed,
                notifications,
                error -> android.util.Log.e("SensorBleService", "CO2 alert processing failed", error)
            );
        }
        return co2Alerts;
    }
    static synchronized NativeBindingRepository bindings(Context context) {
        if (bindings == null) bindings = new NativeBindingRepository(new AndroidBindingStorage(context));
        return bindings;
    }
    static ServiceBindingActions bindingActions(Context context) {
        onMain(); return new ServiceBindingActions(bindings(context), STATE, BleServiceRuntime::disconnect);
    }
    static void start(Context context, boolean visible, String address, String expected) throws IOException {
        onMain(); createChannel(context);
        NativeBindingRepository.Snapshot saved = bindings(context).requireMigrated();
        if (saved.binding != null) {
            if (expected != null && !saved.binding.deviceId.equals(de.lueftlotse.ble.Codec.uuid(expected))) throw new IllegalStateException("BLE binding UUID mismatch");
            expected = saved.binding.deviceId;
        }
        BleServiceState.Run run = STATE.reserve(visible, permitted(context), address, expected, saved.revision);
        Intent intent = new Intent(context, SensorBleService.class).setAction(SensorBleService.START).putExtra("runId", run.id);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
        } catch (RuntimeException error) { STATE.failBeforeOpen(run.id, error.toString()); throw error; }
        MAIN.postDelayed(() -> STATE.failBeforeOpen(run.id, "Start des Sensor-Dienstes dauerte zu lange"), 10000);
    }
    static void startSaved(Context context, boolean visible, String revision) throws IOException {
        onMain();
        NativeBindingRepository.Binding saved = bindingActions(context).automaticBinding(
            NativeBindingRepository.revision(revision), visible, permitted(context)
        );
        if (saved != null) {
            start(context, visible, saved.bleAddress, saved.deviceId);
        }
    }
    static boolean discoveryPermitted(Context context) {
        return permitted(context) && DiscoveryPermissions.granted(Build.VERSION.SDK_INT,
            grant(context, "android.permission.BLUETOOTH_SCAN"),
            grant(context, Manifest.permission.ACCESS_FINE_LOCATION),
            grant(context, "android.permission.ACCESS_BACKGROUND_LOCATION"));
    }
    static void startDiscovery(Context context, boolean visible, String revision, boolean manual) throws IOException {
        onMain();
        if (STATE.active()) return;
        NativeBindingRepository.Snapshot saved = bindings(context).requireMigrated();
        if (!saved.revision.equals(NativeBindingRepository.revision(revision))) throw new NativeBindingRepository.StaleRevision();
        if (!visible || !discoveryPermitted(context)) throw new SecurityException("BLE permissions: Suche nur mit Berechtigung aus sichtbarer App");
        if (manual) saved = bindings(context).enableConnection(saved.revision);
        if (!saved.connectionEnabled) return;
        NativeBindingRepository.Binding binding = saved.binding;
        BleServiceState.Run run = STATE.reserveDiscovery(visible, true,
            binding == null ? null : binding.bleAddress, binding == null ? null : binding.deviceId, saved.revision);
        createChannel(context);
        Intent intent = new Intent(context, SensorBleService.class).setAction(SensorBleService.START).putExtra("runId", run.id);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (RuntimeException error) {
            STATE.failBeforeOpen(run.id, error.toString());
            throw error;
        }
        MAIN.postDelayed(() -> STATE.failBeforeOpen(run.id, "Start des Sensor-Dienstes dauerte zu lange"), 10000);
    }
    static void disconnect(String id, String reason) {
        onMain(); if (!STATE.stop(id, reason)) return;
        if (host != null) host.disconnectRun(id, reason);
    }
}
