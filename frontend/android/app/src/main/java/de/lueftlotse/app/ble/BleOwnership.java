package de.lueftlotse.app.ble;

import java.util.UUID;

/** Process-local exclusion across the legacy plugin and service; never a persisted binding. */
public final class BleOwnership {
    public enum Owner { LEGACY, SERVICE }
    public static final class Lease {
        public final String id = UUID.randomUUID().toString();
        public final Owner owner;
        private Lease(Owner owner) { this.owner = owner; }
    }
    private Lease current;
    public synchronized Lease acquire(Owner owner) {
        if (current != null) throw new IllegalStateException("BLE wird bereits verwendet: " + current.owner);
        current = new Lease(owner); return current;
    }
    public synchronized boolean release(Lease lease) {
        if (lease == null || current != lease) return false; current = null; return true;
    }
    public synchronized String owner() { return current == null ? "none" : current.owner.name().toLowerCase(java.util.Locale.ROOT); }
    public synchronized boolean owns(Lease lease) { return lease != null && current == lease; }
}
