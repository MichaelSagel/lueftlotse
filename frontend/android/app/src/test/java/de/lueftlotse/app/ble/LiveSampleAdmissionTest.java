package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.math.BigInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public class LiveSampleAdmissionTest {
    private static final String ID = "00112233-4455-4677-8899-aabbccddeeff";
    private static final String OTHER = "11112233-4455-4677-8899-aabbccddeeff";
    private final BleServiceState state = new BleServiceState(new BleOwnership());

    private BleServiceState.Run ready(String device, String boot) {
        BleServiceState.Run run = state.reserve(true, true, "01:23:45:67:89:AB", device);
        assertTrue(state.open(run.id, true));
        state.ready(run.id, new Codec.Info(1, device, 16));
        state.protocolStatus(run.id, Codec.message(
            0x80, "requestId", 0, "bootId", boot, "oldest", BigInteger.ZERO,
            "latest", BigInteger.ZERO, "overwrittenThrough", BigInteger.ZERO,
            "timeValid", 0, "firstUndated", BigInteger.ZERO, "storageState", 0
        ));
        return run;
    }

    private Codec.Message sample(String boot) {
        return Codec.message(
            0x8a, "bootId", boot, "sampleCounter", BigInteger.ONE,
            "uptimeMs", BigInteger.TEN, "ppm", 800
        );
    }

    @Test public void capturesSessionIdentityAndWallClockBeforeDisconnect() {
        BleServiceState.Run old = ready(ID, ID);
        NativeLiveSample captured = state.captureLive(old.id, sample(ID), 50, 1794230000123L);
        state.stop(old.id, "Trennen");
        state.closed(old.id, true, "closed");
        ready(OTHER, OTHER);
        assertEquals(ID, captured.deviceId);
        assertEquals(ID, captured.bootId);
        assertEquals(1794230000123L, captured.measuredAt);
        assertNull(state.captureLive(old.id, sample(ID), 60, 2000));
    }

    @Test public void rejectsStoppingUnknownRunAndWrongBoot() {
        BleServiceState.Run run = ready(ID, ID);
        assertNull(state.captureLive("stale", sample(ID), 50, 1000));
        assertNull(state.captureLive(run.id, sample(OTHER), 50, 1000));
        assertNull(state.captureLive(run.id, sample(ID), -1, 1000));
        state.stop(run.id, "Trennen");
        assertNull(state.captureLive(run.id, sample(ID), 50, 1000));
    }

    @Test public void storageErrorRemainsVisibleAcrossReadsDisconnectAndNewRun() {
        BleServiceState.Run run = ready(ID, ID);
        state.liveStorageError("Disk full");
        assertEquals("Disk full", state.snapshot(100).get("liveStorageError"));
        state.stop(run.id, "Trennen");
        state.closed(run.id, true, "closed");
        ready(OTHER, OTHER);
        assertEquals("Disk full", state.snapshot(200).get("liveStorageError"));
    }

    @Test public void admittedWriteFinishesAfterDisconnectWithoutReadingNewSession() throws Exception {
        BleServiceState.Run old = ready(ID, ID);
        NativeLiveSample captured = state.captureLive(old.id, sample(ID), 50, 1000);
        java.util.concurrent.CountDownLatch writing = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        java.util.List<NativeLiveSample> saved = new java.util.ArrayList<>();
        java.util.List<Exception> errors = new java.util.ArrayList<>();
        LiveSampleWriter writer = new LiveSampleWriter(() -> new LiveSampleWriter.Store() {
            public void save(NativeLiveSample value) throws Exception {
                writing.countDown();
                if (!release.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Test write not released");
                }
                saved.add(value);
            }
            public void close() { }
        }, (value, error) -> errors.add(error));
        try {
            writer.submit(captured);
            assertTrue(writing.await(5, java.util.concurrent.TimeUnit.SECONDS));
            state.stop(old.id, "Trennen");
            state.closed(old.id, true, "closed");
            ready(OTHER, OTHER);
            java.util.concurrent.CompletableFuture<Void> drained = writer.drain();
            assertFalse(drained.isDone());
            release.countDown();
            drained.get(5, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals(java.util.Collections.singletonList(captured), saved);
            assertEquals(ID, saved.get(0).deviceId);
            assertTrue(errors.isEmpty());
        } finally {
            release.countDown();
            writer.close().get(5, java.util.concurrent.TimeUnit.SECONDS);
        }
    }
}
