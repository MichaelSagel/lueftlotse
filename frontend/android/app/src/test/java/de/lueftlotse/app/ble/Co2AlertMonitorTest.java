package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.math.BigInteger;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public class Co2AlertMonitorTest {
    private NativeLiveSample sample(long time) {
        return new NativeLiveSample("00112233-4455-4677-8899-aabbccddeeff", Codec.message(
            0x8a, "bootId", "11112233-4455-4677-8899-aabbccddeeff",
            "sampleCounter", BigInteger.valueOf(time + 1), "uptimeMs", BigInteger.valueOf(time), "ppm", 2200
        ), time);
    }

    @Test public void notificationFailureIsIsolatedAndDoesNotRepeatEpisode() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        AtomicInteger errors = new AtomicInteger();
        Thread caller = Thread.currentThread();
        java.util.concurrent.atomic.AtomicLong clock = new java.util.concurrent.atomic.AtomicLong();
        Co2AlertMonitor alerts = new Co2AlertMonitor(
            () -> {
                assertNotSame(caller, Thread.currentThread());
                return new Co2AlertPolicy(new Co2AlertPolicyTest.Memory());
            }, clock::get, () -> true,
            ppm -> {
                assertNotSame(caller, Thread.currentThread());
                attempts.incrementAndGet();
                throw new SecurityException("notification permission revoked");
            }, error -> errors.incrementAndGet()
        );
        try {
            for (long t = 0; t <= 60000; t += 5000) {
                clock.set(t);
                alerts.sample(sample(t), t);
                alerts.drain().get(5, TimeUnit.SECONDS);
            }
            assertEquals(1, attempts.get());
            assertEquals(1, errors.get());
        } finally {
            alerts.close().get(5, TimeUnit.SECONDS);
        }
    }

    @Test public void unreadableLatchDoesNotBecomeAnUnwarnedEpisode() throws Exception {
        AtomicInteger notifications = new AtomicInteger();
        AtomicInteger errors = new AtomicInteger();
        Co2AlertPolicy.Store broken = new Co2AlertPolicy.Store() {
            public boolean warned(String device) throws java.io.IOException {
                throw new java.io.IOException("storage unavailable");
            }
            public void warned(String device, boolean value) {
                fail("Must not overwrite unreadable state");
            }
        };
        Co2AlertMonitor alerts = new Co2AlertMonitor(
            () -> new Co2AlertPolicy(broken), () -> 30000, () -> true,
            ppm -> notifications.incrementAndGet(), error -> errors.incrementAndGet()
        );
        try {
            alerts.sample(sample(30000), 30000);
            alerts.drain().get(5, TimeUnit.SECONDS);
            assertEquals(0, notifications.get());
            assertEquals(1, errors.get());
        } finally {
            alerts.close().get(5, TimeUnit.SECONDS);
        }
    }
    @Test public void disconnectCancelsQueuedSamplesBeforeTheyCanNotify() throws Exception {
        java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        AtomicInteger notifications = new AtomicInteger();
        Co2AlertMonitor alerts = new Co2AlertMonitor(() -> {
            entered.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Test release timeout");
                }
            } catch (InterruptedException error) {
                throw new RuntimeException(error);
            }
            return new Co2AlertPolicy(new Co2AlertPolicyTest.Memory());
        }, () -> 30000, () -> true, ppm -> notifications.incrementAndGet(), error -> fail(error.toString()));
        try {
            alerts.sample(sample(0), 0);
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            for (long t = 5000; t <= 30000; t += 5000) {
                alerts.sample(sample(t), t);
            }
            alerts.interrupted();
            release.countDown();
            alerts.drain().get(5, TimeUnit.SECONDS);
            assertEquals(0, notifications.get());
        } finally {
            release.countDown();
            alerts.close().get(5, TimeUnit.SECONDS);
        }
    }
}
