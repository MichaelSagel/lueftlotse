package de.lueftlotse.app.ble;

/** A failed/pending connect retains ownership until native disconnect AND connect settlement. */
public final class LegacyBleGate {
    public static final class Attempt {
        private final BleOwnership.Lease lease;
        public final String address;
        private boolean connecting = true, disconnected;
        private Attempt(BleOwnership.Lease lease, String address) { this.lease = lease; this.address = address; }
    }
    private final BleOwnership ownership;
    private Attempt active;
    private boolean destroyed;
    public LegacyBleGate(BleOwnership ownership) { this.ownership = ownership; }
    public synchronized Attempt connect(String address) {
        if (address == null || !address.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")) throw new IllegalArgumentException("Ungültige BLE-Adresse");
        if (destroyed || active != null) throw new IllegalStateException("BLE-Verbindung wird bereits verwendet oder beendet");
        active = new Attempt(ownership.acquire(BleOwnership.Owner.LEGACY), address); return active;
    }
    public synchronized Attempt disconnect(String address) {
        if (active == null) {
            if (!ownership.owner().equals("none")) throw new IllegalStateException("BLE gehört einer anderen Sitzung");
            return null;
        }
        if (!active.address.equalsIgnoreCase(address)) throw new IllegalStateException("Falsche BLE-Sitzung");
        return active;
    }
    public synchronized void connectSettled(Attempt attempt) {
        if (attempt == null || attempt != active) return; attempt.connecting = false; releaseIfClosed(attempt);
    }
    public synchronized Attempt destroy() { if (destroyed) return null; destroyed = true; return active; }
    public synchronized void disconnected(Attempt attempt) {
        if (attempt == null || attempt != active) return; attempt.disconnected = true; releaseIfClosed(attempt);
    }
    private void releaseIfClosed(Attempt attempt) {
        if (!attempt.connecting && attempt.disconnected) { ownership.release(attempt.lease); active = null; }
    }
}
