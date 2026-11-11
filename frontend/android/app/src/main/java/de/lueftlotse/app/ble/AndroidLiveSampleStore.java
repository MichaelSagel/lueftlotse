package de.lueftlotse.app.ble;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.File;
import java.util.UUID;

/** Native-only history. Construct, open, query and close exclusively on the disk queue. */
final class AndroidLiveSampleStore extends SQLiteOpenHelper implements LiveSampleWriter.Store {
    static final String DATABASE_NAME = "live-samples-v1.db";

    AndroidLiveSampleStore(Context context) {
        super(context.getApplicationContext(), path(context), null, 1);
    }

    private static String path(Context context) {
        File directory = context.getApplicationContext().getNoBackupFilesDir();
        if (directory == null) {
            throw new IllegalStateException("Native measurement directory unavailable");
        }
        return new File(directory, DATABASE_NAME).getAbsolutePath();
    }

    @Override public void onCreate(SQLiteDatabase database) {
        database.execSQL(
            "CREATE TABLE live_samples ("
                + "measurement_id TEXT NOT NULL PRIMARY KEY, "
                + "device_id TEXT NOT NULL, boot_id TEXT NOT NULL, "
                + "sample_counter TEXT NOT NULL, uptime_ms TEXT NOT NULL, "
                + "ppm INTEGER NOT NULL CHECK(ppm BETWEEN 1 AND 100000), "
                + "measured_at INTEGER NOT NULL, source TEXT NOT NULL CHECK(source = 'sensor'), "
                + "UNIQUE(device_id, boot_id, sample_counter))"
        );
    }

    @Override public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
        throw new SQLiteException("Unsupported native measurement schema upgrade");
    }

    @Override public void save(NativeLiveSample sample) {
        SQLiteDatabase database = getWritableDatabase();
        database.beginTransaction();
        try {
            try (Cursor existing = database.query(
                "live_samples",
                new String[] { "ppm", "uptime_ms" },
                "device_id = ? AND boot_id = ? AND sample_counter = ?",
                new String[] { sample.deviceId, sample.bootId, sample.sampleCounter },
                null,
                null,
                null
            )) {
                if (existing.moveToFirst()) {
                    if (existing.getInt(0) != sample.ppm || !existing.getString(1).equals(sample.uptimeMs)) {
                        throw new SQLiteException("LIVE_SAMPLE identity conflicts with stored ppm/uptimeMs");
                    }
                    database.setTransactionSuccessful();
                    return;
                }
            }
            ContentValues values = new ContentValues();
            values.put("measurement_id", UUID.randomUUID().toString());
            values.put("device_id", sample.deviceId);
            values.put("boot_id", sample.bootId);
            values.put("sample_counter", sample.sampleCounter);
            values.put("uptime_ms", sample.uptimeMs);
            values.put("ppm", sample.ppm);
            values.put("measured_at", sample.measuredAt);
            values.put("source", "sensor");
            database.insertOrThrow("live_samples", null, values);
            database.setTransactionSuccessful();
        } finally {
            database.endTransaction();
        }
    }
}
