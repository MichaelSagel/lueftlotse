package de.lueftlotse.app.ble;

import org.junit.Test;
import static org.junit.Assert.*;

public class LegacyBleGateTest {
    private static final String ADDRESS = "01:23:45:67:89:AB";
    @Test public void cleanupWaitsForLateConnectSettlement() {
        BleOwnership owner = new BleOwnership(); LegacyBleGate gate = new LegacyBleGate(owner); LegacyBleGate.Attempt attempt = gate.connect(ADDRESS);
        assertSame(attempt, gate.disconnect(ADDRESS)); gate.disconnected(attempt);
        assertThrows(IllegalStateException.class, () -> owner.acquire(BleOwnership.Owner.SERVICE));
        gate.connectSettled(attempt); assertNotNull(owner.acquire(BleOwnership.Owner.SERVICE));
    }
    @Test public void failedConnectCannotReleaseBeforeConfirmedNativeDisconnect() {
        BleOwnership owner = new BleOwnership(); LegacyBleGate gate = new LegacyBleGate(owner); LegacyBleGate.Attempt attempt = gate.connect(ADDRESS);
        gate.connectSettled(attempt); assertEquals("legacy", owner.owner());
        assertThrows(IllegalStateException.class, () -> gate.connect(ADDRESS)); gate.disconnected(attempt); assertEquals("none", owner.owner());
    }
    @Test public void staleDisconnectCannotReleaseReplacementLease() {
        BleOwnership owner = new BleOwnership(); LegacyBleGate gate = new LegacyBleGate(owner); LegacyBleGate.Attempt old = gate.connect(ADDRESS);
        gate.connectSettled(old); gate.disconnected(old); LegacyBleGate.Attempt next = gate.connect(ADDRESS);
        gate.disconnected(old); gate.connectSettled(old); assertEquals("legacy", owner.owner()); assertSame(next, gate.disconnect(ADDRESS));
    }
    @Test public void otherActivityOrAddressCannotReleaseLegacyOwner() {
        BleOwnership owner = new BleOwnership(); LegacyBleGate first = new LegacyBleGate(owner), second = new LegacyBleGate(owner);
        first.connect(ADDRESS); assertThrows(IllegalStateException.class, () -> second.disconnect(ADDRESS));
        assertThrows(IllegalStateException.class, () -> first.disconnect("11:23:45:67:89:AB"));
    }
    @Test public void expiredOwnerLeaseCannotReleaseNewOwner() {
        BleOwnership owner = new BleOwnership(); BleOwnership.Lease old = owner.acquire(BleOwnership.Owner.LEGACY); owner.release(old);
        BleOwnership.Lease next = owner.acquire(BleOwnership.Owner.SERVICE); assertFalse(owner.release(old)); assertTrue(owner.owns(next));
    }
    @Test public void activityDestroyRetainsOwnerUntilPendingConnectAndCleanupSettle() {
        BleOwnership owner = new BleOwnership(); LegacyBleGate gate = new LegacyBleGate(owner);
        LegacyBleGate.Attempt attempt = gate.connect(ADDRESS);
        assertSame(attempt, gate.destroy()); assertNull(gate.destroy());
        gate.disconnected(attempt); assertEquals("legacy", owner.owner());
        gate.connectSettled(attempt); assertEquals("none", owner.owner());
        assertThrows(IllegalStateException.class, () -> gate.connect(ADDRESS));
        assertNotNull(new LegacyBleGate(owner).connect(ADDRESS));
    }
    @Test public void destroyingActivityWithoutLegacyConnectionCannotStopService() {
        BleOwnership owner = new BleOwnership(); BleOwnership.Lease service = owner.acquire(BleOwnership.Owner.SERVICE);
        assertNull(new LegacyBleGate(owner).destroy()); assertTrue(owner.owns(service));
    }
}
