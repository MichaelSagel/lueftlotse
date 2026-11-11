package de.lueftlotse.app.ble;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Looper;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Independent read-only history worker. No service, binding migration or writer is started. */
final class AndroidLiveSampleHistory {
    private static final ExecutorService READS = Executors.newSingleThreadExecutor(task -> {
        return new Thread(task, "LueftlotseHistory");
    });

    static CompletableFuture<Map<String, Object>> load(Context context, NativeHistoryQuery query) {
        Context application = context.getApplicationContext();
        return CompletableFuture.supplyAsync(() -> read(application, query), READS);
    }

    private static Map<String, Object> read(Context context, NativeHistoryQuery query) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("History read on main looper");
        }
        File directory = context.getNoBackupFilesDir();
        if (directory == null) {
            throw new IllegalStateException("Native measurement directory unavailable");
        }
        File file = new File(directory, AndroidLiveSampleStore.DATABASE_NAME);
        try {
            Os.stat(file.getAbsolutePath());
        } catch (ErrnoException error) {
            if (error.errno == OsConstants.ENOENT && query.cursor == null) {
                return page(new ArrayList<>(), null);
            }
            throw new IllegalStateException("Native measurement database unavailable", error);
        }
        try (SQLiteDatabase database = SQLiteDatabase.openDatabase(
            file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY
        )) {
            long snapshot = query.snapshot;
            if (query.cursor == null) {
                try (Cursor maximum = database.rawQuery("SELECT COALESCE(MAX(rowid), 0) FROM live_samples", null)) {
                    maximum.moveToFirst();
                    snapshot = maximum.getLong(0);
                }
            }
            String where = "measured_at >= ? AND measured_at < ? AND rowid <= ?";
            List<String> args = new ArrayList<>();
            args.add(Long.toString(query.from));
            args.add(Long.toString(query.to));
            args.add(Long.toString(snapshot));
            if (!query.deviceId.isEmpty()) {
                where += " AND device_id = ?";
                args.add(query.deviceId);
            }
            if (query.cursor != null) {
                String timeAfter = "(measured_at" + query.comparison
                    + " OR (measured_at = ? AND rowid" + query.comparison + "))";
                where += query.byPpm
                    ? " AND (ppm" + query.comparison + " OR (ppm = ? AND " + timeAfter + "))"
                    : " AND " + timeAfter;
                if (query.byPpm) {
                    args.add(Integer.toString(query.lastPpm));
                    args.add(Integer.toString(query.lastPpm));
                }
                args.add(Long.toString(query.lastTime));
                args.add(Long.toString(query.lastTime));
                args.add(Long.toString(query.lastRow));
            }
            List<Map<String, Object>> items = new ArrayList<>();
            String next = null;
            try (Cursor rows = database.rawQuery(
                "SELECT rowid, measurement_id, device_id, boot_id, measured_at, ppm, source "
                    + "FROM live_samples WHERE " + where + " ORDER BY " + query.orderBy()
                    + " LIMIT " + (query.pageSize + 1),
                args.toArray(new String[0])
            )) {
                while (rows.moveToNext()) {
                    if (items.size() == query.pageSize) {
                        rows.moveToPrevious();
                        next = query.next(snapshot, rows.getLong(4), rows.getInt(5), rows.getLong(0));
                        break;
                    }
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("measurementId", rows.getString(1));
                    item.put("deviceId", rows.getString(2));
                    item.put("bootId", rows.getString(3));
                    item.put("measuredAtMs", Long.toString(rows.getLong(4)));
                    item.put("ppm", rows.getInt(5));
                    item.put("source", rows.getString(6));
                    items.add(item);
                }
            }
            return page(items, next);
        }
    }

    private static Map<String, Object> page(List<Map<String, Object>> items, String nextCursor) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("items", items);
        result.put("nextCursor", nextCursor);
        return result;
    }
}
