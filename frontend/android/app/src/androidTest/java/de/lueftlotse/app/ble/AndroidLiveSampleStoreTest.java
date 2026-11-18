package de.lueftlotse.app.ble;

import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import de.lueftlotse.ble.Codec;
import de.lueftlotse.ble.UInt64;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real SQLite under the isolated target app's noBackup directory. No production data. */
@RunWith(AndroidJUnit4.class)
public class AndroidLiveSampleStoreTest {
    private static final String ID = "00112233-4455-4677-8899-aabbccddeeff";
    private static final String OTHER = "11112233-4455-4677-8899-aabbccddeeff";
    private Context context;
    private File directory;
    private AndroidLiveSampleStore store;

    @Before public void setUp() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("Unexpected instrumentation target", "de.lueftlotse.app.sqlitetest", target.getPackageName());
        File root = target.getNoBackupFilesDir();
        assertNotNull("Target noBackup directory unavailable", root);
        File candidate = new File(root, "live-sample-test-" + UUID.randomUUID()).getCanonicalFile();
        assertEquals("Test directory must be a direct child of noBackup", root.getCanonicalFile(), candidate.getParentFile());
        assertTrue("Cannot create isolated test directory: " + candidate, candidate.mkdir());
        // Set ownership only after successful creation; failed setup must not delete anything.
        directory = candidate;
        context = new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getNoBackupFilesDir() { return directory; }
        };
        store = newStore();
    }

    @After public void tearDown() {
        try {
            if (store != null) {
                store.close();
            }
        } finally {
            if (directory != null && directory.exists()) {
                File database = new File(directory, AndroidLiveSampleStore.DATABASE_NAME);
                if (database.exists()) {
                    assertTrue("Cannot delete isolated test database: " + database, SQLiteDatabase.deleteDatabase(database));
                }
                assertTrue("Cannot remove isolated test directory: " + directory, directory.delete());
            }
        }
    }

    private AndroidLiveSampleStore newStore() {
        return new AndroidLiveSampleStore(
            context,
            () -> 3000,
            () -> 0,
            error -> fail(error.toString())
        );
    }

    private NativeLiveSample sample(String boot, BigInteger counter, BigInteger uptime, int ppm, long time) {
        return new NativeLiveSample(ID, Codec.message(
            0x8a, "bootId", boot, "sampleCounter", counter, "uptimeMs", uptime, "ppm", ppm
        ), time);
    }

    private String[] onlyRow() {
        try (Cursor rows = store.getReadableDatabase().rawQuery(
            "SELECT measurement_id, measured_at, sample_counter, uptime_ms, ppm, source FROM live_samples",
            null
        )) {
            assertEquals(1, rows.getCount());
            assertTrue(rows.moveToFirst());
            String[] values = new String[6];
            for (int i = 0; i < values.length; i++) {
                values[i] = rows.getString(i);
            }
            return values;
        }
    }

    @Test public void reopeningAndReconnectDuplicatePreserveOriginalIdAndReceipt() {
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 1000));
        String[] original = onlyRow();
        store.close();
        store = newStore();
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 9999));
        assertArrayEquals(original, onlyRow());
        assertEquals("1000", original[1]);
        assertEquals("sensor", original[5]);
        UUID.fromString(original[0]);
        assertEquals(
            new File(directory, AndroidLiveSampleStore.DATABASE_NAME).getAbsolutePath(),
            store.getReadableDatabase().getPath()
        );
    }

    @Test public void newBootAndDifferentDeviceHaveIndependentIdentities() {
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 1000));
        store.save(sample(OTHER, BigInteger.ONE, BigInteger.ZERO, 900, 2000));
        store.save(new NativeLiveSample(OTHER, Codec.message(
            0x8a, "bootId", ID, "sampleCounter", BigInteger.ONE,
            "uptimeMs", BigInteger.TEN, "ppm", 800
        ), 3000));
        try (Cursor rows = store.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM live_samples", null)) {
            assertTrue(rows.moveToFirst());
            assertEquals(3, rows.getInt(0));
        }
    }

    @Test public void maximumUint64SurvivesDiskReopenAsText() {
        store.save(sample(ID, UInt64.MAX, UInt64.MAX, 2100, 1234));
        store.close();
        store = newStore();
        String[] row = onlyRow();
        assertEquals("18446744073709551615", row[2]);
        assertEquals("18446744073709551615", row[3]);
        try (Cursor types = store.getReadableDatabase().rawQuery(
            "SELECT typeof(sample_counter), typeof(uptime_ms) FROM live_samples", null
        )) {
            assertTrue(types.moveToFirst());
            assertEquals("text", types.getString(0));
            assertEquals("text", types.getString(1));
        }
    }

    @Test public void changedPpmIsConflictAndDoesNotOverwriteOriginal() {
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 1000));
        String[] original = onlyRow();
        try {
            store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 801, 2000));
            fail("Expected ppm conflict");
        } catch (SQLiteException expected) {
            assertTrue(expected.getMessage().contains("conflicts"));
        }
        assertArrayEquals(original, onlyRow());
    }

    @Test public void changedUptimeIsConflictAndDoesNotOverwriteOriginal() {
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 1000));
        String[] original = onlyRow();
        try {
            store.save(sample(ID, BigInteger.ONE, BigInteger.ONE, 800, 2000));
            fail("Expected uptime conflict");
        } catch (SQLiteException expected) {
            assertTrue(expected.getMessage().contains("conflicts"));
        }
        assertArrayEquals(original, onlyRow());
    }

    @Test public void retainedHistorySurvivesReopenBeyondHistoryPageSize() {
        for (int i = 1; i <= 64; i++) {
            store.save(sample(ID, BigInteger.valueOf(i), BigInteger.valueOf(i), 800, i));
        }
        store.save(sample(ID, BigInteger.valueOf(65), BigInteger.valueOf(65), 900, 2000));
        store.close();
        store = newStore();
        try (Cursor rows = store.getReadableDatabase().rawQuery(
            "SELECT COUNT(*), MIN(measured_at), MAX(measured_at) FROM live_samples", null
        )) {
            assertTrue(rows.moveToFirst());
            assertEquals(65, rows.getInt(0));
            assertEquals(1, rows.getLong(1));
            assertEquals(2000, rows.getLong(2));
        }
    }

    private void add(int counter, long time) {
        store.save(sample(ID, BigInteger.valueOf(counter), BigInteger.valueOf(counter), 800, time));
    }

    private int count() {
        try (Cursor rows = store.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM live_samples", null)) {
            assertTrue(rows.moveToFirst());
            return rows.getInt(0);
        }
    }

    private String idFor(int counter) {
        try (Cursor rows = store.getReadableDatabase().rawQuery(
            "SELECT measurement_id FROM live_samples WHERE sample_counter = ?",
            new String[] { Integer.toString(counter) }
        )) {
            return rows.moveToFirst() ? rows.getString(0) : null;
        }
    }

    @Test public void openingDeletesOnlyStrictlyOlderThanEightDays() {
        add(1, 999);
        add(2, 1000);
        add(3, 1001);
        String boundaryId = idFor(2);
        String freshId = idFor(3);
        store.close();
        store = new AndroidLiveSampleStore(context,
            () -> AndroidLiveSampleStore.RETENTION_MS + 1000, () -> 0, error -> fail(error.toString()));
        assertEquals(2, count());
        assertNull(idFor(1));
        assertEquals(boundaryId, idFor(2));
        assertEquals(freshId, idFor(3));
        assertEquals(1, store.getReadableDatabase().getVersion());
    }

    @Test public void emptyDatabaseCleanupKeepsTheFileAndSchema() {
        store.close();
        store = new AndroidLiveSampleStore(context,
            () -> AndroidLiveSampleStore.RETENTION_MS + 1000, () -> 0, error -> fail(error.toString()));
        assertEquals(0, count());
        assertTrue(new File(directory, AndroidLiveSampleStore.DATABASE_NAME).exists());
        assertEquals(1, store.getReadableDatabase().getVersion());
    }

    @Test public void cleanupDuringRecordingRunsHourlyInsteadOfOnEverySample() {
        store.close();
        long[] wall = { AndroidLiveSampleStore.RETENTION_MS + 1000 };
        long[] elapsed = { 0 };
        store = new AndroidLiveSampleStore(context, () -> wall[0], () -> elapsed[0], error -> fail(error.toString()));
        add(1, 1000);
        add(2, 1001);
        String boundaryId = idFor(2);
        wall[0]++;
        elapsed[0] = AndroidLiveSampleStore.CLEANUP_INTERVAL_MS - 1;
        add(3, wall[0]);
        assertNotNull(idFor(1));
        assertEquals(3, count());
        elapsed[0]++;
        add(4, wall[0]);
        assertNull(idFor(1));
        assertEquals(boundaryId, idFor(2));
        assertEquals(3, count());
    }

    @Test public void failedOpeningCleanupRollsBackAndRetriesOnlyAfterInterval() {
        add(1, 998);
        add(2, 999);
        add(3, 1000);
        String firstId = idFor(1);
        store.getWritableDatabase().execSQL(
            "CREATE TRIGGER reject_cleanup BEFORE DELETE ON live_samples WHEN OLD.sample_counter = '2' "
                + "BEGIN SELECT RAISE(FAIL, 'Injected cleanup failure'); END"
        );
        store.close();
        List<Exception> errors = new ArrayList<>();
        long[] elapsed = { 0 };
        long now = AndroidLiveSampleStore.RETENTION_MS + 1000;
        store = new AndroidLiveSampleStore(context, () -> now, () -> elapsed[0], errors::add);
        assertEquals(3, count());
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).getMessage().contains("Injected cleanup failure"));
        assertEquals(firstId, idFor(1));
        add(4, now);
        assertEquals(4, count());
        assertEquals(1, errors.size());
        store.getWritableDatabase().execSQL("DROP TRIGGER reject_cleanup");
        elapsed[0] = AndroidLiveSampleStore.CLEANUP_INTERVAL_MS - 1;
        add(5, now);
        assertEquals(5, count());
        elapsed[0]++;
        add(6, now);
        assertEquals(4, count());
        assertNull(idFor(1));
        assertNull(idFor(2));
        assertNotNull(idFor(3));
        assertTrue(new File(directory, AndroidLiveSampleStore.DATABASE_NAME).exists());
    }

    @Test public void failedPeriodicCleanupPreservesRowsAndAllowsFreshWrites() {
        store.close();
        long[] wall = { AndroidLiveSampleStore.RETENTION_MS + 1000 };
        long[] elapsed = { 0 };
        List<Exception> errors = new ArrayList<>();
        store = new AndroidLiveSampleStore(context, () -> wall[0], () -> elapsed[0], errors::add);
        add(1, 1000);
        String originalId = idFor(1);
        store.getWritableDatabase().execSQL(
            "CREATE TRIGGER reject_cleanup BEFORE DELETE ON live_samples "
                + "BEGIN SELECT RAISE(FAIL, 'Injected periodic cleanup failure'); END"
        );
        wall[0]++;
        elapsed[0] = AndroidLiveSampleStore.CLEANUP_INTERVAL_MS;
        add(2, wall[0]);
        assertEquals(1, errors.size());
        assertEquals(originalId, idFor(1));
        assertEquals(2, count());
        add(3, wall[0]);
        assertEquals(1, errors.size());
        assertEquals(3, count());
        assertTrue(new File(directory, AndroidLiveSampleStore.DATABASE_NAME).exists());
    }

    @Test public void failedInsertPreservesExistingHistoryAfterReopen() {
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 1000));
        String[] original = onlyRow();
        store.getWritableDatabase().execSQL(
            "CREATE TRIGGER reject_sample BEFORE INSERT ON live_samples "
                + "BEGIN SELECT RAISE(ABORT, 'Injected write failure'); END"
        );
        assertThrows(SQLiteException.class, () -> store.save(
            sample(ID, BigInteger.valueOf(2), BigInteger.valueOf(20), 900, 2000)
        ));
        store.close();
        store = newStore();
        assertArrayEquals(original, onlyRow());
    }

    @Test public void corruptDatabaseIsRetainedByWriterAndReadOnlyHistory() throws Exception {
        store.close();
        File file = new File(directory, AndroidLiveSampleStore.DATABASE_NAME);
        byte[] original = new byte[4096];
        Arrays.fill(original, (byte) 64);
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(original);
        }
        SQLiteException error = assertThrows(SQLiteException.class, () -> store.getWritableDatabase());
        assertTrue(error.getMessage(), error.getMessage().contains("files retained"));
        assertArrayEquals(original, bytes(file));

        ExecutionException readError = assertThrows(ExecutionException.class, () -> AndroidLiveSampleHistory.load(
            context, new NativeHistoryQuery("0", "3000", null, "time-desc", 50, null)
        ).get(5, TimeUnit.SECONDS));
        assertTrue(readError.getCause() instanceof SQLiteException);
        assertNotNull(readError.getCause().getMessage());
        assertArrayEquals(original, bytes(file));
    }

    private byte[] bytes(File file) throws Exception {
        byte[] value = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) {
            int offset = 0;
            while (offset < value.length) {
                int count = input.read(value, offset, value.length - offset);
                assertTrue(count > 0);
                offset += count;
            }
        }
        return value;
    }

    @Test public void failedInsertRollsBackAndRetryIsNotMistakenForDuplicate() {
        SQLiteDatabase database = store.getWritableDatabase();
        database.execSQL(
            "CREATE TRIGGER reject_sample BEFORE INSERT ON live_samples "
                + "BEGIN SELECT RAISE(ABORT, 'Injected write failure'); END"
        );
        try {
            store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 1000));
            fail("Expected write failure");
        } catch (SQLiteException expected) {
            assertTrue(expected.getMessage().contains("Injected write failure"));
        }
        try (Cursor rows = database.rawQuery("SELECT COUNT(*) FROM live_samples", null)) {
            assertTrue(rows.moveToFirst());
            assertEquals(0, rows.getInt(0));
        }
        database.execSQL("DROP TRIGGER reject_sample");
        store.save(sample(ID, BigInteger.ONE, BigInteger.TEN, 800, 2000));
        assertEquals("2000", onlyRow()[1]);
    }
}
