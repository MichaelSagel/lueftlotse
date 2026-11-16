package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.math.BigInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public class Co2AlertPolicyTest {
    private static final String DEVICE = "00112233-4455-4677-8899-aabbccddeeff";
    private static final String BOOT = "11112233-4455-4677-8899-aabbccddeeff";
    private final Memory store = new Memory();
    private final Co2AlertPolicy policy = new Co2AlertPolicy(store);

    static final class Memory implements Co2AlertPolicy.Store {
        final java.util.Map<String, Boolean> values = new java.util.HashMap<>();
        public boolean warned(String deviceId) {
            return values.getOrDefault(deviceId, false);
        }
        public void warned(String deviceId, boolean value) {
            values.put(deviceId, value);
        }
    }
    private long counter;

    private NativeLiveSample receipt(int ppm, String boot) {
        return new NativeLiveSample(DEVICE, Codec.message(
            0x8a, "bootId", boot, "sampleCounter", BigInteger.valueOf(++counter),
            "uptimeMs", BigInteger.valueOf(counter * 1000), "ppm", ppm
        ), 1000000 - counter * 10000); // Calendar clock moving backwards must not affect duration.
    }
    private boolean sample(int ppm, long time) throws Exception {
        return policy.sample(receipt(ppm, BOOT), time, time);
    }
    private void highUntil(long through) throws Exception {
        for (long time = 0; time <= through; time += 5000) {
            assertEquals(time >= 30000, sample(2000, time));
        }
    }
    @Test public void boundaryRequiresAnotherFreshSampleAtThirtySeconds() throws Exception {
        highUntil(25000);
        assertFalse(sample(2000, 29999));
        assertTrue(sample(2000, 30000));
        assertFalse(sample(2500, 35000));
    }
    @Test public void shortSpikeAndBelowThresholdResetPendingDuration() throws Exception {
        highUntil(10000);
        assertFalse(sample(1999, 15000));
        for (long t = 20000; t < 50000; t += 5000) {
            assertFalse(sample(2100, t));
        }
        assertTrue(sample(2100, 50000));
    }
    @Test public void disconnectResetsPendingDuration() throws Exception {
        highUntil(25000);
        policy.interrupted();
        for (long t = 30000; t < 60000; t += 5000) {
            assertFalse(sample(2000, t));
        }
        assertTrue(sample(2000, 60000));
    }
    @Test public void fifteenSecondGapIsStaleEvenIfNoTimerRanDuringSleep() throws Exception {
        highUntil(15000);
        assertFalse(sample(2200, 30000));
        for (long t = 35000; t < 60000; t += 5000) {
            assertFalse(sample(2200, t));
        }
        assertTrue(sample(2200, 60000));
    }
    @Test public void delayedDeliveryCannotConfirmOrRearmAnEpisode() throws Exception {
        highUntil(25000);
        assertFalse(policy.sample(receipt(2000, BOOT), 30000, 45000));
        assertFalse(sample(2100, 45001));
        for (long t = 50001; t < 75001; t += 5000) {
            assertFalse(sample(2100, t));
        }
        assertTrue(sample(2100, 75001));
        assertFalse(policy.sample(receipt(1700, BOOT), 80000, 95000));
        assertFalse(sample(2500, 95001));
    }
    @Test public void warnedEpisodeSurvivesGapDisconnectAndNewBoot() throws Exception {
        highUntil(30000);
        policy.interrupted();
        for (long t = 100000; t <= 150000; t += 5000) {
            assertFalse(policy.sample(receipt(2200, DEVICE), t, t));
        }
        assertFalse(sample(1800, 155000));
        assertFalse(sample(1999, 160000));
        assertFalse(sample(2100, 165000));
    }
    @Test public void onlyFreshBelow1800RearmsThenRequiresAnotherThirtySeconds() throws Exception {
        highUntil(30000);
        assertFalse(sample(1800, 35000));
        assertFalse(sample(2200, 40000));
        assertFalse(sample(1799, 45000));
        for (long t = 50000; t < 80000; t += 5000) {
            assertFalse(sample(2000, t));
        }
        assertTrue(sample(2000, 80000));
        assertFalse(sample(2000, 85000));
    }
    @Test public void duplicateSamplesDoNotExtendFreshnessOrRearm() throws Exception {
        NativeLiveSample first = receipt(2000, BOOT);
        assertFalse(policy.sample(first, 0, 0));
        assertFalse(policy.sample(first, 10000, 10000));
        assertFalse(policy.sample(first, 20000, 20000));
        assertFalse(sample(2000, 30000));
        for (long t = 35000; t < 60000; t += 5000) {
            assertFalse(sample(2000, t));
        }
        assertTrue(sample(2000, 60000));
    }
    @Test public void persistedEpisodeSurvivesPolicyRecreationUntilFreshLow() throws Exception {
        highUntil(30000);
        Co2AlertPolicy reopened = new Co2AlertPolicy(store);
        for (long t = 100000; t <= 135000; t += 5000) {
            assertFalse(reopened.sample(receipt(2300, DEVICE), t, t));
        }
        assertFalse(reopened.sample(receipt(1799, DEVICE), 140000, 140000));
        Co2AlertPolicy rearmed = new Co2AlertPolicy(store);
        for (long t = 145000; t < 175000; t += 5000) {
            assertFalse(rearmed.sample(receipt(2000, DEVICE), t, t));
        }
        assertTrue(rearmed.sample(receipt(2000, DEVICE), 175000, 175000));
    }
    @Test public void permissionDenialDoesNotConsumeAnUndeliveredEpisode() throws Exception {
        for (long t = 0; t <= 40000; t += 5000) {
            assertFalse(policy.sample(receipt(2200, BOOT), t, t, false));
        }
        assertFalse(store.warned(DEVICE));
        assertTrue(policy.sample(receipt(2200, BOOT), 45000, 45000, true));
        assertFalse(policy.sample(receipt(2200, BOOT), 50000, 50000, true));
    }
}
