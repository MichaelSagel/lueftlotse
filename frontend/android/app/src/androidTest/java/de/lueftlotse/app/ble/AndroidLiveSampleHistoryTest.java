package de.lueftlotse.app.ble;

import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import de.lueftlotse.ble.Codec;
import java.io.File;
import java.io.FileInputStream;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real SQL filtering/keyset pagination in an isolated target, with no BLE service or HTTP. */
@RunWith(AndroidJUnit4.class)
public class AndroidLiveSampleHistoryTest {
    private static final String ID = "00112233-4455-4677-8899-aabbccddeeff";
    private static final String OTHER = "11112233-4455-4677-8899-aabbccddeeff";
    private Context context;
    private File directory;
    private AndroidLiveSampleStore store;

    @Before public void setUp() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("de.lueftlotse.app.sqlitetest", target.getPackageName());
        File root = target.getNoBackupFilesDir();
        assertNotNull(root);
        File candidate = new File(root, "history-test-" + UUID.randomUUID()).getCanonicalFile();
        assertEquals(root.getCanonicalFile(), candidate.getParentFile());
        assertTrue("Cannot create history test directory: " + candidate, candidate.mkdir());
        directory = candidate;
        context = new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getNoBackupFilesDir() { return directory; }
        };
        store = new AndroidLiveSampleStore(
            context,
            () -> 3000,
            () -> 0,
            error -> fail(error.toString())
        );
    }

    @After public void tearDown() {
        try {
            if (store != null) {
                store.close();
            }
        } finally {
            if (directory != null && directory.exists()) {
                SQLiteDatabase.deleteDatabase(databaseFile());
                assertTrue("Cannot remove history test directory: " + directory, directory.delete());
            }
        }
    }

    private File databaseFile() {
        return new File(directory, AndroidLiveSampleStore.DATABASE_NAME);
    }

    private String add(int counter, long time, int ppm, String device) {
        store.save(new NativeLiveSample(device, Codec.message(
            0x8a, "bootId", ID, "sampleCounter", BigInteger.valueOf(counter),
            "uptimeMs", BigInteger.valueOf(counter), "ppm", ppm
        ), time));
        try (Cursor row = store.getReadableDatabase().rawQuery(
            "SELECT measurement_id FROM live_samples WHERE sample_counter = ? AND device_id = ?",
            new String[] { Integer.toString(counter), device }
        )) {
            assertTrue(row.moveToFirst());
            return row.getString(0);
        }
    }

    private NativeHistoryQuery query(String sort, int size, String cursor) {
        return new NativeHistoryQuery("1000", "4000", null, sort, size, cursor);
    }

    private Map<String, Object> load(NativeHistoryQuery query) throws Exception {
        return AndroidLiveSampleHistory.load(context, query).get(5, TimeUnit.SECONDS);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> items(Map<String, Object> page) {
        return (List<Map<String, Object>>) page.get("items");
    }

    private List<String> ids(Map<String, Object> page) {
        List<String> ids = new ArrayList<>();
        for (Map<String, Object> item : items(page)) {
            ids.add((String) item.get("measurementId"));
        }
        return ids;
    }

    @Test public void missingAndEmptyDatabaseReturnEmptyPagesWithoutCreatingMissingFile() throws Exception {
        assertFalse(databaseFile().exists());
        Map<String, Object> missing = load(query("time-desc", 50, null));
        assertTrue(items(missing).isEmpty());
        assertNull(missing.get("nextCursor"));
        assertFalse(databaseFile().exists());
        store.getWritableDatabase();
        assertTrue(items(load(query("time-desc", 50, null))).isEmpty());
    }

    @Test public void periodIsHalfOpenAndUsesSavedReceiptTimeWithOptionalDeviceFilter() throws Exception {
        add(1, 999, 600, ID);
        String first = add(2, 1000, 700, ID);
        String last = add(3, 1999, 800, ID);
        add(4, 2000, 900, ID);
        add(1, 1500, 1000, OTHER);
        Map<String, Object> page = load(new NativeHistoryQuery("1000", "2000", ID, "time-asc", 50, null));
        assertEquals(Arrays.asList(first, last), ids(page));
        assertEquals("1000", items(page).get(0).get("measuredAtMs"));
        assertEquals("sensor", items(page).get(0).get("source"));
    }

    @Test public void allFourSortsCoverWholePeriodAcrossPagesAndEqualValuesStayStable() throws Exception {
        String a = add(1, 1000, 900, ID);
        String b = add(2, 2000, 700, ID);
        String c = add(3, 2000, 900, ID);
        String d = add(4, 2000, 900, ID);
        String e = add(5, 3000, 800, ID);
        String[] sorts = { "time-desc", "time-asc", "ppm-desc", "ppm-asc" };
        List<List<String>> expected = Arrays.asList(
            Arrays.asList(e, d, c, b, a), Arrays.asList(a, b, c, d, e),
            Arrays.asList(d, c, a, e, b), Arrays.asList(b, e, a, c, d)
        );
        store.close();
        byte[] before = digest();
        for (int i = 0; i < sorts.length; i++) {
            List<String> all = new ArrayList<>();
            String cursor = null;
            int pages = 0;
            do {
                Map<String, Object> page = load(query(sorts[i], 2, cursor));
                assertTrue(items(page).size() <= 2);
                all.addAll(ids(page));
                cursor = (String) page.get("nextCursor");
                assertTrue("Pagination must terminate", ++pages <= 3);
            } while (cursor != null);
            assertEquals(sorts[i], expected.get(i), all);
            assertEquals(3, pages);
        }
        assertArrayEquals("Reading history must not change database bytes", before, digest());
    }

    @Test public void laterInsertsDoNotShiftAnOpenSnapshotAndRefreshIncludesThem() throws Exception {
        String a = add(1, 1000, 900, ID);
        String b = add(2, 2000, 900, ID);
        String c = add(3, 3000, 900, ID);
        Map<String, Object> first = load(query("time-desc", 2, null));
        assertEquals(Arrays.asList(c, b), ids(first));
        add(4, 1500, 900, ID);
        add(5, 3500, 900, ID);
        Map<String, Object> next = load(query("time-desc", 2, (String) first.get("nextCursor")));
        assertEquals(Arrays.asList(a), ids(next));
        assertNull(next.get("nextCursor"));
        assertEquals(5, items(load(query("time-desc", 50, null))).size());
    }

    @Test public void invalidPeriodsSortsSizesAndMismatchedCursorsAreRejected() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> new NativeHistoryQuery("1000", "1000", null, "time-desc", 50, null));
        assertThrows(IllegalArgumentException.class, () -> query("ppm;DROP TABLE live_samples", 50, null));
        assertThrows(IllegalArgumentException.class, () -> query("time-desc", 51, null));
        assertThrows(IllegalArgumentException.class, () -> query("time-desc", 50, "broken"));
        add(1, 1000, 900, ID);
        add(2, 2000, 900, ID);
        String cursor = (String) load(query("time-desc", 1, null)).get("nextCursor");
        assertThrows(IllegalArgumentException.class, () -> query("ppm-desc", 1, cursor));
        assertThrows(IllegalArgumentException.class, () -> query("time-desc", 2, cursor));
        assertThrows(IllegalArgumentException.class, () -> new NativeHistoryQuery("1000", "5000", null, "time-desc", 1, cursor));
        assertThrows(IllegalArgumentException.class, () -> new NativeHistoryQuery("1000", "4000", OTHER, "time-desc", 1, cursor));
    }

    @Test public void existingInvalidDatabaseFailsInsteadOfPretendingHistoryIsEmpty() throws Exception {
        try (SQLiteDatabase ignored = SQLiteDatabase.openOrCreateDatabase(databaseFile(), null)) {
            // Existing database with no measurement schema must not be treated as absent.
        }
        ExecutionException error = assertThrows(ExecutionException.class, () -> load(query("time-desc", 50, null)));
        assertTrue(error.getCause() instanceof SQLiteException);
    }

    private byte[] digest() throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(databaseFile())) {
            byte[] bytes = new byte[4096];
            int count;
            while ((count = input.read(bytes)) != -1) {
                hash.update(bytes, 0, count);
            }
        }
        return hash.digest();
    }
}
