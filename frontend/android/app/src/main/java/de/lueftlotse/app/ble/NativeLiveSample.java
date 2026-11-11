package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import de.lueftlotse.ble.UInt64;

/** Immutable receipt captured before disk work; measuredAt is the phone's wall clock. */
final class NativeLiveSample {
    final String deviceId;
    final String bootId;
    final String sampleCounter;
    final String uptimeMs;
    final int ppm;
    final long measuredAt;

    NativeLiveSample(String deviceId, Codec.Message sample, long measuredAt) {
        if (sample.type != 0x8a) {
            throw new IllegalArgumentException("Expected LIVE_SAMPLE");
        }
        Codec.encodeBody(sample);
        this.deviceId = Codec.uuid(deviceId);
        this.bootId = sample.text("bootId");
        this.sampleCounter = UInt64.toDecimal(sample.big("sampleCounter"));
        this.uptimeMs = UInt64.toDecimal(sample.big("uptimeMs"));
        this.ppm = Math.toIntExact(sample.number("ppm"));
        this.measuredAt = measuredAt;
    }
}
