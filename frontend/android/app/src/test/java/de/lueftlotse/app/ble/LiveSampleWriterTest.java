package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import de.lueftlotse.ble.UInt64;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import static org.junit.Assert.*;

public class LiveSampleWriterTest {
    private static final String ID = "00112233-4455-4677-8899-aabbccddeeff";
    private static final String OTHER = "11112233-4455-4677-8899-aabbccddeeff";

    private NativeLiveSample receipt(String device, long time) {
        return new NativeLiveSample(device, Codec.message(
            0x8a, "bootId", ID, "sampleCounter", UInt64.MAX,
            "uptimeMs", UInt64.MAX, "ppm", 2100
        ), time);
    }

    @Test public void receiptPreservesFullUint64AndCalendarTime() {
        NativeLiveSample sample = receipt(ID, 1794230000123L);
        assertEquals("18446744073709551615", sample.sampleCounter);
        assertEquals("18446744073709551615", sample.uptimeMs);
        assertEquals(1794230000123L, sample.measuredAt);
    }

    @Test public void gracefulCloseDrainsReceiptsSeriallyOffCallerThread() throws Exception {
        Thread caller = Thread.currentThread();
        List<NativeLiveSample> saved = new ArrayList<>();
        List<Exception> errors = new ArrayList<>();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        LiveSampleWriter writer = new LiveSampleWriter(() -> new LiveSampleWriter.Store() {
            public void save(NativeLiveSample sample) throws Exception {
                assertNotSame(caller, Thread.currentThread());
                if (saved.isEmpty()) {
                    entered.countDown();
                    if (!release.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Test write not released");
                    }
                }
                saved.add(sample);
            }
            public void close() {
                assertNotSame(caller, Thread.currentThread());
            }
        }, (sample, error) -> errors.add(error));
        NativeLiveSample oldSession = receipt(ID, 100);
        NativeLiveSample nextSession = receipt(OTHER, 200);
        try {
            writer.submit(oldSession);
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            writer.submit(nextSession);
            // Disconnect/owner shutdown must leave both already accepted receipts intact.
            java.util.concurrent.CompletableFuture<Void> closed = writer.close();
            assertFalse(closed.isDone());
            release.countDown();
            closed.get(5, TimeUnit.SECONDS);
            assertEquals(java.util.Arrays.asList(oldSession, nextSession), saved);
            assertEquals(ID, saved.get(0).deviceId);
            assertEquals(OTHER, saved.get(1).deviceId);
            assertTrue(errors.isEmpty());
        } finally {
            release.countDown();
        }
    }

    @Test public void failedWriteIsReportedAndDoesNotPreventLaterWrite() throws Exception {
        List<NativeLiveSample> saved = new ArrayList<>();
        List<Exception> errors = new ArrayList<>();
        IllegalStateException failure = new IllegalStateException("Disk full");
        LiveSampleWriter writer = new LiveSampleWriter(() -> new LiveSampleWriter.Store() {
            public void save(NativeLiveSample sample) {
                if (sample.measuredAt == 100) {
                    throw failure;
                }
                saved.add(sample);
            }
            public void close() { }
        }, (sample, error) -> errors.add(error));
        writer.submit(receipt(ID, 100));
        NativeLiveSample later = receipt(OTHER, 200);
        writer.submit(later);
        writer.drain().get(5, TimeUnit.SECONDS);
        writer.close().get(5, TimeUnit.SECONDS);
        assertEquals(java.util.Collections.singletonList(failure), errors);
        assertEquals(java.util.Collections.singletonList(later), saved);
    }

    @Test public void failedOpenIsReportedAndRetriedOnNextReceipt() throws Exception {
        List<Exception> errors = new ArrayList<>();
        int[] opens = { 0 };
        int[] writes = { 0 };
        LiveSampleWriter writer = new LiveSampleWriter(() -> {
            if (++opens[0] == 1) {
                throw new IllegalStateException("Cannot open database");
            }
            return new LiveSampleWriter.Store() {
                public void save(NativeLiveSample sample) { writes[0]++; }
                public void close() { }
            };
        }, (sample, error) -> errors.add(error));
        writer.submit(receipt(ID, 100));
        writer.submit(receipt(ID, 200));
        writer.close().get(5, TimeUnit.SECONDS);
        assertEquals(1, errors.size());
        assertEquals(2, opens[0]);
        assertEquals(1, writes[0]);
    }
}
