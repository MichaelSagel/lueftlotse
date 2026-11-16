package de.lueftlotse.app.ble;

import java.math.BigInteger;
import java.io.IOException;

/** Service-queue policy. Receipt/processing times are elapsedRealtime, never calendar time. */
final class Co2AlertPolicy {
    interface Store {
        boolean warned(String deviceId) throws IOException;
        void warned(String deviceId, boolean value) throws IOException;
    }
    static final long HIGH_DURATION_MS = 30000;
    static final long FRESH_MS = 15000;
    private String deviceId;
    private String bootId;
    private BigInteger counter;
    private long lastArrival = -1;
    private long highSince = -1;
    private boolean warned;
    private final Store store;

    Co2AlertPolicy(Store store) {
        this.store = store;
    }

    boolean sample(NativeLiveSample sample, long arrival, long now) throws IOException {
        return sample(sample, arrival, now, true);
    }

    boolean sample(NativeLiveSample sample, long arrival, long now, boolean notificationAllowed) throws IOException {
        if (arrival < 0 || now < arrival || now - arrival >= FRESH_MS) {
            interrupted();
            return false;
        }
        if (!sample.deviceId.equals(deviceId)) {
            boolean saved = store.warned(sample.deviceId);
            deviceId = sample.deviceId;
            bootId = null;
            counter = null;
            warned = saved;
            interrupted();
        }
        BigInteger nextCounter = new BigInteger(sample.sampleCounter);
        if (sample.bootId.equals(bootId) && counter != null && nextCounter.compareTo(counter) <= 0) {
            return false;
        }
        if (bootId != null && !sample.bootId.equals(bootId)) {
            interrupted();
        }
        if (lastArrival >= 0 && (arrival < lastArrival || arrival - lastArrival >= FRESH_MS)) {
            interrupted();
        }
        bootId = sample.bootId;
        counter = nextCounter;
        lastArrival = arrival;
        if (sample.ppm < 1800 && warned) {
            store.warned(deviceId, false);
            warned = false;
        }
        if (sample.ppm < 2000) {
            highSince = -1;
            return false;
        }
        if (warned) {
            return false;
        }
        if (highSince < 0) {
            highSince = arrival;
        }
        if (arrival - highSince < HIGH_DURATION_MS || !notificationAllowed) {
            return false;
        }
        store.warned(deviceId, true);
        warned = true;
        highSince = -1;
        return true;
    }

    void interrupted() {
        highSince = -1;
        lastArrival = -1;
        // A gap, reconnect or boot change never rearms an already warned episode.
    }
}
