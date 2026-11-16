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
    private ServiceJournal journal;
    private ServiceReconnect reconnect;
    private final Runnable journalTick = new Runnable() {
        public void run() {
            if (destroyed || journal == null) return;
            journal.tick(); BleServiceRuntime.MAIN.postDelayed(this, 1000);
        }
    };

    ServiceJournal journal(String token) {
        BleServiceRuntime.onMain();
        if (journal == null || !BleServiceRuntime.STATE.matches(token) || !token.equals(runId)) throw new IllegalStateException("Native journal unavailable");
        return journal;
    }
    void revokeJournalOwner(String owner) { if (journal != null) journal.revokeOwner(owner); }
    private void openJournal(String token, String generation, GattTransport.Connection c) {
        journal = new ServiceJournal(token, generation, new ServiceJournal.Port() {
            public java.util.concurrent.CompletionStage<String> acquire() { return transport.acquireJournal(c); }
            public java.util.concurrent.CompletionStage<Integer> status(String lease) { return transport.journalStatus(c, lease); }
            public java.util.concurrent.CompletionStage<Integer> fetch(String lease, java.math.BigInteger after, int limit) { return transport.fetch(c, lease, after, limit); }
            public java.util.concurrent.CompletionStage<String> beginCommit(String lease, String batch) { return transport.beginCommit(c, lease, batch); }
            public java.util.concurrent.CompletionStage<Integer> commit(String lease, String commit) { return transport.commitSucceeded(c, lease, commit); }
            public java.util.concurrent.CompletionStage<Boolean> revoke(String lease) { return transport.revokeJournal(c, lease); }
            public void close() { BleServiceRuntime.disconnect(token, "Journal client revoked / uncertain operation"); }
        }, action -> BleServiceRuntime.MAIN.post(action), SystemClock::elapsedRealtime);
        BleServiceRuntime.MAIN.post(journalTick);
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        BleServiceRuntime.onMain();
        startId = id; // Includes notification actions and stale intents; stop the latest service start.
        if (intent == null) { stopIfIdle(id); return START_NOT_STICKY; }
        String token = intent.getStringExtra("runId");
        if (DISCONNECT.equals(intent.getAction())) {
            try { BleServiceRuntime.bindingActions(this).disconnect(token, "Über Benachrichtigung getrennt"); }
            catch (Exception error) {
                android.util.Log.e("SensorBleService", "Verbindungsabsicht nicht gespeichert; Verbindung geschlossen", error);
                android.widget.Toast.makeText(this, "Verbindung getrennt. Verbindungsabsicht konnte nicht gespeichert werden.", android.widget.Toast.LENGTH_LONG).show();
            }
            stopIfIdle(id);
            return START_NOT_STICKY;
        }
        if (!START.equals(intent.getAction()) || !BleServiceRuntime.STATE.matches(token)) {
            stopIfIdle(id); return START_NOT_STICKY;
        }
        if (token.equals(runId)) return START_NOT_STICKY;
        BleServiceState.Run run = BleServiceRuntime.STATE.current();
        try {
            BleServiceRuntime.createChannel(this);
            if (!BleServiceRuntime.permitted(this)) throw new SecurityException("Bluetooth-/Dienstberechtigung fehlt");
            BluetoothManager manager = getSystemService(BluetoothManager.class);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null) throw new IllegalStateException("Bluetooth nicht verfügbar");
            runId = token; startId = id;
            Notification notification = notification("Verbindung wird hergestellt");
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(NOTIFICATION_ID, notification);
            if (!BleServiceRuntime.STATE.open(token, BleServiceRuntime.permitted(this))) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(id); return START_NOT_STICKY; }
            BleServiceRuntime.host = this;
            reconnect = new ServiceReconnect(new ServiceReconnect.Port() {
                public ServiceReconnect.Timer schedule(Runnable action, long delayMs) {
                    android.util.Log.i("SensorBleService", "Reconnect in " + delayMs + " ms");
                    BleServiceRuntime.MAIN.postDelayed(action, delayMs);
                    return () -> BleServiceRuntime.MAIN.removeCallbacks(action);
                }
                public NativeBindingRepository.Binding savedBinding() throws Exception {
                    return BleServiceRuntime.bindings(SensorBleService.this).requireMigrated().binding;
                }
                public boolean permitted() {
                    return !destroyed && BleServiceRuntime.STATE.matches(token)
                        && !BleServiceRuntime.STATE.stopping(token) && BleServiceRuntime.permitted(SensorBleService.this);
                }
                public void connect(NativeBindingRepository.Binding saved) {
                    connectAttempt(token, saved.bleAddress, saved.deviceId);
                }
                public void terminal(String reason) {
                    BleServiceRuntime.disconnect(token, reason);
                }
            });
            connectAttempt(token, run.address, run.expectedDeviceId);
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
    private void connectAttempt(String token, String address, String expectedDeviceId) {
        BleServiceRuntime.onMain();
        if (destroyed || !token.equals(runId) || BleServiceRuntime.STATE.stopping(token)) {
            return;
        }
        try {
            BluetoothManager manager = getSystemService(BluetoothManager.class);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null) {
                throw new IllegalStateException("Bluetooth nicht verfügbar");
            }
            transport = AndroidGattTransport.create(this, adapter, new GattTransport.Listener() {
                public void event(GattTransport.Connection c, ProtocolSession.Event event) {
                    if (event.kind == ProtocolSession.Kind.READY) c.ready().thenAccept(info -> BleServiceRuntime.MAIN.post(() -> {
                        if (!currentConnection(token, c)) return;
                        if (!BleServiceRuntime.bindingActions(SensorBleService.this).ready(token, info)) return;
                        reconnect.ready(new NativeBindingRepository.Binding(info.deviceId, address, true));
                        BleServiceRuntime.STATE.protocolStatus(token, event.message);
                        openJournal(token, event.generation, c);
                        if (!destroyed && c.state() == GattTransport.State.READY) {
                            updateServiceNotification("Sensor verbunden");
                        }
                    }));
                    if (event.kind != ProtocolSession.Kind.READY) BleServiceRuntime.MAIN.post(() -> {
                        if (!currentConnection(token, c)) return;
                        if (event.message != null && event.message.type == 0x80) BleServiceRuntime.STATE.protocolStatus(token, event.message);
                        if (journal != null) journal.event(event);
                    });
                    if (event.kind == ProtocolSession.Kind.NOTICE && event.message != null && event.message.type == 0xff && event.message.number("code") == 7) {
                        BleServiceRuntime.MAIN.post(() -> {
                            if (currentConnection(token, c)) {
                                BleServiceRuntime.STATE.sensorError(token);
                                BleServiceRuntime.co2Alerts(SensorBleService.this).interrupted();
                            }
                        });
                    }
                }
                public void live(GattTransport.Connection c, Codec.Message sample, long arrival) {
                    // Capture the calendar receipt now, never derive UTC from elapsedRealtime.
                    final long receivedAt = System.currentTimeMillis();
                    BleServiceRuntime.MAIN.post(() -> {
                        if (destroyed || !currentConnection(token, c)) {
                            return;
                        }
                        NativeLiveSample receipt = BleServiceRuntime.STATE.captureLive(token, sample, arrival, receivedAt);
                        if (receipt == null) {
                            return;
                        }
                        BleServiceRuntime.liveSamples(SensorBleService.this).submit(receipt);
                        BleServiceRuntime.STATE.live(token, sample, arrival);
                        BleServiceRuntime.co2Alerts(SensorBleService.this).sample(receipt, arrival);
                    });
                }
                public void closed(GattTransport.Connection c, String reason) {
                    c.closed().whenComplete((unused, error) -> BleServiceRuntime.MAIN.post(() -> closedRun(token, c, error == null, reason)));
                }
            });
            connection = transport.connect(address, expectedDeviceId);
            BleServiceRuntime.STATE.connectionStarted(token, connection.id);
            android.util.Log.i("SensorBleService", "BLE attempt " + connection.id + " for " + expectedDeviceId);
        } catch (RuntimeException error) {
            if (connection != null) {
                BleServiceRuntime.disconnect(token, error.toString());
            } else {
                if (transport != null) {
                    transport.close();
                    transport = null;
                }
                afterClose(token, true, false, error.toString());
            }
        }
    }
    private boolean currentConnection(String token, GattTransport.Connection candidate) {
        return candidate == connection && BleServiceRuntime.STATE.matchesConnection(token, candidate.id);
    }
    void disconnectRun(String token, String reason) {
        BleServiceRuntime.onMain();
        if (token == null || !token.equals(runId)) {
            return;
        }
        BleServiceRuntime.co2Alerts(SensorBleService.this).interrupted();
        if (reconnect != null) {
            reconnect.cancel();
        }
        if (journal != null) {
            journal.closed("Connection closing");
        }
        BleServiceRuntime.MAIN.removeCallbacks(journalTick);
        if (connection != null) {
            connection.cancel();
            if (transport != null) {
                transport.close();
            }
        } else {
            BleServiceRuntime.STATE.closed(token, true, reason);
            finishService(token);
        }
    }
    private void closedRun(String token, GattTransport.Connection c, boolean clean, String reason) {
        if (c != connection || !token.equals(runId)) {
            return;
        }
        if (journal != null) {
            journal.closed(reason);
            journal = null;
        }
        BleServiceRuntime.MAIN.removeCallbacks(journalTick);
        if (transport != null) {
            transport.close();
            transport = null;
        }
        connection = null;
        afterClose(token, clean, c.identityRejected(), reason);
    }
    private void afterClose(String token, boolean clean, boolean identityRejected, String reason) {
        BleServiceRuntime.co2Alerts(SensorBleService.this).interrupted();
        android.util.Log.i("SensorBleService", "BLE closed: " + reason);
        if (!destroyed && !BleServiceRuntime.STATE.stopping(token) && reconnect != null
                && reconnect.unexpectedClose(clean, identityRejected)) {
            BleServiceRuntime.STATE.reconnecting(token, reason);
            updateServiceNotification("Verbindung unterbrochen. Wiederverbinden …");
            return;
        }
        if (reconnect != null) {
            reconnect.cancel();
        }
        if (identityRejected) {
            BleServiceRuntime.STATE.bindingError("Info UUID mismatch: " + reason);
        }
        BleServiceRuntime.STATE.closed(token, clean, reason);
        finishService(token);
    }
    private void finishService(String token) {
        if (BleServiceRuntime.host == this) {
            BleServiceRuntime.host = null;
        }
        // Keep foreground lifetime until accepted disk work drains; never stop a newer run.
        BleServiceRuntime.liveSamples(this).drain().thenRun(() -> BleServiceRuntime.MAIN.post(() -> {
            BleServiceState.Run current = BleServiceRuntime.STATE.current();
            if (!destroyed && token.equals(runId) && current != null && current.id.equals(token)) {
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelfResult(startId);
            }
        }));
    }
    private void stopIfIdle(int id) {
        if (BleServiceRuntime.STATE.active()) {
            return;
        }
        if (runId == null) {
            stopSelfResult(id);
        } else {
            finishService(runId);
        }
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
    private void updateServiceNotification(String text) {
        try {
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text));
        } catch (RuntimeException error) {
            android.util.Log.e("SensorBleService", "Service notification could not be updated", error);
        }
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        destroyed = true;
        if (runId != null) { BleServiceRuntime.STATE.stop(runId, "Sensor-Dienst beendet"); disconnectRun(runId, "Sensor-Dienst beendet"); }
        if (BleServiceRuntime.host == this) BleServiceRuntime.host = null;
        super.onDestroy();
    }
}
