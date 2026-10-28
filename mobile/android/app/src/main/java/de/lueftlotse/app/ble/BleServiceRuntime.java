package de.lueftlotse.app.ble;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import java.util.Map;

/** Process state only. No Activity reference, database, saved binding or automatic startup. */
public final class BleServiceRuntime {
    public static final BleOwnership OWNERSHIP = new BleOwnership();
    static final BleServiceState STATE = new BleServiceState(OWNERSHIP);
    static final Handler MAIN = new Handler(Looper.getMainLooper());
    static final String CHANNEL = "sensor_connection_v1";
    static SensorBleService host;
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
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        boolean notifications = manager != null && manager.areNotificationsEnabled();
        if (notifications && Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(CHANNEL);
            notifications = channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        return ServicePermissionPolicy.canConnect(Build.VERSION.SDK_INT,
                grant(context, Manifest.permission.BLUETOOTH) && grant(context, Manifest.permission.BLUETOOTH_ADMIN),
                grant(context, "android.permission.BLUETOOTH_CONNECT"),
                grant(context, "android.permission.FOREGROUND_SERVICE"),
                grant(context, "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE"),
                grant(context, "android.permission.POST_NOTIFICATIONS"), notifications);
    }
    static Map<String, Object> snapshot() { onMain(); return STATE.snapshot(SystemClock.elapsedRealtime()); }
    static void start(Context context, boolean visible, String address, String expected) {
        onMain(); createChannel(context);
        BleServiceState.Run run = STATE.reserve(visible, permitted(context), address, expected);
        Intent intent = new Intent(context, SensorBleService.class).setAction(SensorBleService.START).putExtra("runId", run.id);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent); else context.startService(intent);
        } catch (RuntimeException error) { STATE.failBeforeOpen(run.id, error.toString()); throw error; }
        MAIN.postDelayed(() -> STATE.failBeforeOpen(run.id, "Start des Sensor-Dienstes dauerte zu lange"), 10000);
    }
    static void disconnect(String id, String reason) {
        onMain(); if (!STATE.stop(id, reason)) return;
        if (host != null) host.disconnectRun(id);
    }
}
