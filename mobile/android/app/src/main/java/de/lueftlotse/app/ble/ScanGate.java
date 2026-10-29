package de.lueftlotse.app.ble;

/** A scan occupies admission until its launch settled AND an explicit stop succeeded. No GATT. */
public final class ScanGate {
    public static final class Attempt {
        private final BleOwnership.Lease lease;
        private boolean launching = true;
        private Attempt(BleOwnership.Lease lease) { this.lease = lease; }
    }
    private final BleOwnership ownership;
    private Attempt active;
    private boolean destroyed;
    public ScanGate(BleOwnership ownership) { this.ownership = ownership; }
    public synchronized Attempt begin() {
        if (destroyed || active != null) throw new IllegalStateException("Suche noch aktiv oder nicht sicher beendet");
        active = new Attempt(ownership.acquire(BleOwnership.Owner.LEGACY)); return active;
    }
    public synchronized void settled(Attempt attempt) { if (attempt == active) attempt.launching = false; }
    public synchronized Attempt current() { return active; }
    public synchronized void stopped(Attempt attempt) {
        if (attempt == null || attempt != active) return;
        if (attempt.launching) throw new IllegalStateException("Suchstart noch nicht abgeschlossen; Stopp erneut bestätigen");
        ownership.release(attempt.lease); active = null;
    }
    public synchronized void destroy() { destroyed = true; }
}
