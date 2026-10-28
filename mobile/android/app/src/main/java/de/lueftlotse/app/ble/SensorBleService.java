package de.lueftlotse.app.ble;

import android.app.*;
import android.bluetooth.*;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.*;
import de.lueftlotse.app.MainActivity;
import de.lueftlotse.app.R;
import de.lueftlotse.ble.*;
import de.lueftlotse.ble.transport.*;

/** Started, unbound, non-sticky service. The Activity never owns this transport. */
public final class SensorBleService extends Service {
    static final String START = "de.lueftlotse.ble.START", DISCONNECT = "de.lueftlotse.ble.DISCONNECT";
    private static final int NOTIFICATION_ID = 4101;
    private GattTransport transport;
    private GattTransport.Connection connection;
    private String runId;
    private int startId;
    private boolean destroyed;

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        BleServiceRuntime.onMain();
        startId = id; // Includes notification actions and stale intents; stop the latest service start.
        if (intent == null) { if (!BleServiceRuntime.STATE.active()) stopSelfResult(id); return START_NOT_STICKY; }
        String token = intent.getStringExtra("runId");
        if (DISCONNECT.equals(intent.getAction())) {
            BleServiceRuntime.disconnect(token, "Über Benachrichtigung getrennt");
            if (!BleServiceRuntime.STATE.active()) stopSelfResult(id);
            return START_NOT_STICKY;
        }
        if (!START.equals(intent.getAction()) || !BleServiceRuntime.STATE.matches(token)) {
            if (!BleServiceRuntime.STATE.active()) stopSelfResult(id); return START_NOT_STICKY;
        }
        if (token.equals(runId) && connection != null) return START_NOT_STICKY;
        BleServiceState.Run run = BleServiceRuntime.STATE.current();
        try {
            BleServiceRuntime.createChannel(this);
            if (!BleServiceRuntime.permitted(this)) throw new SecurityException("Bluetooth-/Benachrichtigungsberechtigung fehlt");
            BluetoothManager manager = getSystemService(BluetoothManager.class);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null) throw new IllegalStateException("Bluetooth nicht verfügbar");
            runId = token; startId = id;
            Notification notification = notification("Verbindung wird hergestellt");
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(NOTIFICATION_ID, notification);
            if (!BleServiceRuntime.STATE.open(token, BleServiceRuntime.permitted(this))) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(id); return START_NOT_STICKY; }
            BleServiceRuntime.host = this;
            transport = AndroidGattTransport.create(this, adapter, new GattTransport.Listener() {
                public void event(GattTransport.Connection c, ProtocolSession.Event event) {
                    if (event.kind == ProtocolSession.Kind.READY) c.ready().thenAccept(info -> BleServiceRuntime.MAIN.post(() -> {
                        if (c != connection || !BleServiceRuntime.STATE.matches(token)) return;
                        BleServiceRuntime.STATE.ready(token, info);
                        if (!destroyed && c.state() == GattTransport.State.READY) getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification("Sensor verbunden"));
                    }));
                    if (event.kind == ProtocolSession.Kind.NOTICE && event.message != null && event.message.type == 0xff && event.message.number("code") == 7) {
                        BleServiceRuntime.MAIN.post(() -> { if (c == connection) BleServiceRuntime.STATE.sensorError(token); });
                    }
                }
                public void live(GattTransport.Connection c, Codec.Message sample, long arrival) {
                    BleServiceRuntime.MAIN.post(() -> { if (c == connection) BleServiceRuntime.STATE.live(token, sample, arrival); });
                }
                public void closed(GattTransport.Connection c, String reason) {
                    c.closed().whenComplete((unused, error) -> BleServiceRuntime.MAIN.post(() -> closedRun(token, c, error == null, reason)));
                }
            });
            connection = transport.connect(run.address, run.expectedDeviceId);
        } catch (RuntimeException error) {
            if (connection != null && token.equals(runId)) { BleServiceRuntime.disconnect(token, error.toString()); }
            else {
                BleServiceRuntime.STATE.failBeforeOpen(token, error.toString());
                // No connect handle was issued if factory/connect threw synchronously.
                BleServiceRuntime.STATE.closed(token, true, error.toString());
                if (transport != null) transport.close();
                stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(id);
            }
        }
        return START_NOT_STICKY;
    }
    void disconnectRun(String token) {
        BleServiceRuntime.onMain(); if (token == null || !token.equals(runId)) return;
        if (connection != null) connection.cancel();
        if (transport != null) transport.close();
    }
    private void closedRun(String token, GattTransport.Connection c, boolean clean, String reason) {
        if (c != connection || !token.equals(runId)) return;
        BleServiceRuntime.STATE.closed(token, clean, reason);
        if (transport != null) transport.close();
        if (BleServiceRuntime.host == this) BleServiceRuntime.host = null;
        if (!destroyed) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(startId); }
    }
    private Notification notification(String text) {
        Intent disconnect = new Intent(this, SensorBleService.class).setAction(DISCONNECT).putExtra("runId", runId)
                .setData(Uri.parse("lueftlotse:ble/" + runId));
        PendingIntent action = PendingIntent.getService(this, 0, disconnect, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent content = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, BleServiceRuntime.CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(R.drawable.ic_ble_status).setContentTitle("Lüftlotse Sensor").setContentText(text)
                .setContentIntent(content).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE).setPriority(Notification.PRIORITY_LOW)
                .setSound(null).setVibrate(null).addAction(new Notification.Action.Builder(null, "Trennen", action).build()).build();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        destroyed = true;
        if (runId != null) { BleServiceRuntime.STATE.stop(runId, "Sensor-Dienst beendet"); disconnectRun(runId); }
        if (BleServiceRuntime.host == this) BleServiceRuntime.host = null;
        super.onDestroy();
    }
}
