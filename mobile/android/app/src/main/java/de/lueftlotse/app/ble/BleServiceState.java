package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.util.*;

/** Service state machine. Android dispatches all commands/callbacks on its main looper. */
public final class BleServiceState {
    public enum Phase { STOPPED, STARTING, CONNECTING, READY, STOPPING, ERROR }
    public static final class Run {
        public final String id = UUID.randomUUID().toString(), address, expectedDeviceId;
        private final BleOwnership.Lease lease;
        private boolean opened, stopping, closed;
        private Run(String address, String expected, BleOwnership.Lease lease) { this.address = address; expectedDeviceId = expected; this.lease = lease; }
    }
    private final BleOwnership ownership;
    private Run run;
    private Phase phase = Phase.STOPPED;
    private Codec.Info info;
    private Map<String, Object> sample;
    private boolean sampleValid;
    private String reason;
    private long receivedAt;
    public BleServiceState(BleOwnership ownership) { this.ownership = ownership; }
    public synchronized Run reserve(boolean visible, boolean permitted, String address, String expected) {
        if (!visible) throw new IllegalStateException("Start nur aus einer sichtbaren Activity");
        if (!permitted) throw new IllegalStateException("Bluetooth- und Benachrichtigungsberechtigungen fehlen");
        if (active()) throw new IllegalStateException("Sensor-Dienst ist bereits aktiv");
        if (address == null || !address.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")) throw new IllegalArgumentException("Ungültige BLE-Adresse");
        String expectedId = expected == null ? null : Codec.uuid(expected);
        run = new Run(address, expectedId, ownership.acquire(BleOwnership.Owner.SERVICE));
        phase = Phase.STARTING; info = null; sample = null; sampleValid = false; reason = null; return run;
    }
    public synchronized boolean active() { return run != null && ownership.owns(run.lease); }
    public synchronized Run current() { return run; }
    public synchronized boolean matches(String id) { return active() && run.id.equals(id); }
    /** Returns false for stale/duplicate starts; no second transport may be constructed. */
    public synchronized boolean open(String id, boolean permitted) {
        if (!matches(id) || run.opened || run.stopping) return false;
        if (!permitted) { failBeforeOpen(id, "Berechtigungen fehlen"); return false; }
        run.opened = true; phase = Phase.CONNECTING; return true;
    }
    public synchronized void failBeforeOpen(String id, String error) {
        if (!matches(id) || run.opened) return;
        ownership.release(run.lease); phase = Phase.ERROR; reason = error;
    }
    public synchronized boolean stop(String id, String why) {
        if (!matches(id) || run.stopping) return false;
        run.stopping = true; reason = why;
        if (!run.opened) { ownership.release(run.lease); phase = Phase.STOPPED; }
        else phase = Phase.STOPPING;
        return true;
    }
    public synchronized void ready(String id, Codec.Info value) {
        if (!matches(id) || run.stopping || phase != Phase.CONNECTING) return; info = value; phase = Phase.READY;
    }
    public synchronized void live(String id, Codec.Message value, long arrival) {
        if (!matches(id) || run.stopping || phase != Phase.READY || value.type != 0x8a || arrival < 0) return;
        Map<String, Object> copy = new LinkedHashMap<>(value.toBridge());
        copy.put("receivedAtElapsedMs", Long.toString(arrival)); sample = Collections.unmodifiableMap(copy); receivedAt = arrival;
        sampleValid = true; reason = null;
    }
    public synchronized void sensorError(String id) {
        if (!matches(id) || run.stopping || phase != Phase.READY) return;
        sampleValid = false; reason = "Sensor meldet einen Messfehler";
    }
    public synchronized void closed(String id, boolean clean, String why) {
        if (!matches(id) || run.closed) return;
        run.closed = true;
        if (clean) ownership.release(run.lease);
        phase = clean ? Phase.STOPPED : Phase.ERROR; reason = why; run.stopping = true;
    }
    public synchronized Map<String, Object> snapshot(long now) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("state", phase.name().toLowerCase(Locale.ROOT)); result.put("owner", ownership.owner());
        result.put("runId", run == null ? null : run.id); result.put("bleAddress", run == null ? null : run.address);
        result.put("deviceId", info == null ? null : info.deviceId); result.put("reason", reason);
        result.put("lastSample", sample); result.put("nowElapsedMs", Long.toString(now));
        result.put("sampleAvailable", phase == Phase.READY && sampleValid && sample != null && now >= receivedAt && now - receivedAt < 15000);
        return Collections.unmodifiableMap(result);
    }
}
