package de.lueftlotse.app.ble;

import android.app.*;
import android.content.*;
import android.os.Build;
import de.lueftlotse.app.MainActivity;
import de.lueftlotse.app.R;
import java.util.function.IntConsumer;

/** Application-context delivery, independent of Activity, WebView and backend. */
final class AndroidCo2Notifications implements IntConsumer {
    private static final int CO2_ALERT_ID = 4102;
    private static final String CO2_ALERT_CHANNEL = "co2_high_v1";
    private final Context context;

    AndroidCo2Notifications(Context context) {
        this.context = context.getApplicationContext();
    }
    boolean allowed() {
        return BleServiceRuntime.notificationsPermitted(context, CO2_ALERT_CHANNEL);
    }
    public void accept(int ppm) {
        // Notification failure must never stop BLE or the independent SQLite writer.
        try {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel channel = new NotificationChannel(
                    CO2_ALERT_CHANNEL, "CO₂-Warnungen", NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("Warnung bei mindestens 30 Sekunden erhöhtem CO₂-Wert");
                manager.createNotificationChannel(channel);
            }
            if (!allowed()) {
                android.util.Log.i("SensorBleService", "CO2 alert suppressed: notifications not permitted");
                return;
            }
            PendingIntent content = PendingIntent.getActivity(
                context, 0, new Intent(context, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CO2_ALERT_CHANNEL)
                : new Notification.Builder(context);
            manager.notify(CO2_ALERT_ID, builder.setSmallIcon(R.drawable.ic_ble_status)
                .setContentTitle("Lüftlotse: Bitte lüften")
                .setContentText("CO₂ ist erhöht: " + ppm + " ppm")
                .setContentIntent(content).setAutoCancel(true)
                .setCategory(Notification.CATEGORY_STATUS).setPriority(Notification.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_ALL).build());
            android.util.Log.i("SensorBleService", "CO2 alert posted: " + ppm + " ppm");
        } catch (RuntimeException error) {
            android.util.Log.e("SensorBleService", "CO2 alert could not be posted", error);
        }
    }
}
