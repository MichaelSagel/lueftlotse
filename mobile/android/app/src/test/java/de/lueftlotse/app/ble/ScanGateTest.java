package de.lueftlotse.app.ble;

import org.junit.Test;
import static org.junit.Assert.*;

public class ScanGateTest {
    private final BleOwnership owners = new BleOwnership();
    private final ScanGate scans = new ScanGate(owners);
    @Test public void serviceCannotStartUntilLaunchSettlesAndStopIsConfirmed() {
        ScanGate.Attempt scan = scans.begin();
        assertThrows(IllegalStateException.class, () -> owners.acquire(BleOwnership.Owner.SERVICE));
        assertThrows(IllegalStateException.class, () -> scans.stopped(scan));
        scans.settled(scan);
        assertThrows(IllegalStateException.class, () -> owners.acquire(BleOwnership.Owner.SERVICE));
        scans.stopped(scan); assertNotNull(owners.acquire(BleOwnership.Owner.SERVICE));
    }
    @Test public void failedStopRetainsAdmissionAndCanBeRetriedWithoutStartingAnotherScan() {
        ScanGate.Attempt scan = scans.begin(); scans.settled(scan);
        // A platform stop exception never calls stopped().
        assertThrows(IllegalStateException.class, scans::begin);
        assertThrows(IllegalStateException.class, () -> owners.acquire(BleOwnership.Owner.SERVICE));
        scans.stopped(scan); ScanGate.Attempt next = scans.begin();
        scans.stopped(scan); assertSame(next, scans.current());
    }
    @Test public void serviceExcludesScanAndWebViewCleanupDoesNotReleaseService() {
        BleOwnership.Lease service = owners.acquire(BleOwnership.Owner.SERVICE);
        assertThrows(IllegalStateException.class, scans::begin); scans.destroy(); scans.stopped(null);
        assertTrue(owners.owns(service)); assertThrows(IllegalStateException.class, scans::begin);
    }
    @Test public void lateLaunchAfterDestroyRequiresCleanupAndCannotAuthorizeAnotherScan() {
        ScanGate.Attempt scan = scans.begin(); scans.destroy();
        assertThrows(IllegalStateException.class, () -> scans.stopped(scan)); scans.settled(scan);
        assertThrows(IllegalStateException.class, () -> owners.acquire(BleOwnership.Owner.SERVICE));
        scans.stopped(scan); scans.stopped(scan); assertEquals("none", owners.owner());
        assertThrows(IllegalStateException.class, scans::begin);
    }
}
