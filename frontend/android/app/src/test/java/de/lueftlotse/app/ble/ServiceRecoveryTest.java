package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.Test;
import static org.junit.Assert.*;
import static de.lueftlotse.app.ble.NativeBindingRepositoryTest.*;

public class ServiceRecoveryTest {
    private final Memory disk = new Memory();
    private final NativeBindingRepository repository = new NativeBindingRepository(disk);
    private final BleOwnership ownership = new BleOwnership();
    private final BleServiceState state = new BleServiceState(ownership);

    @Test public void nullIntentAndRedeliveredStartUseRecoveryButUnknownActionsDoNot() throws Exception {
        assertTrue(ServiceRecovery.requested(false, false, state));
        assertTrue(ServiceRecovery.requested(true, true, state));
        assertFalse(ServiceRecovery.requested(true, false, state));
        NativeBindingRepository.Snapshot saved = repository.migrate(binding());
        BleServiceState.Run visible = state.reserveDiscovery(true, true, ADDRESS, ID, saved.revision);
        assertFalse(ServiceRecovery.requested(true, true, state));
        assertTrue(ServiceRecovery.requested(false, false, state));
        assertNull(ServiceRecovery.reserve(repository, state, true));
        state.stop(visible.id, "cancelled before start");
        assertFalse(ServiceRecovery.requested(true, true, state));
    }

    @Test public void newProcessRestoresNewDiscoveryRunWithoutUiOrBindingWrite() throws Exception {
        NativeBindingRepository.Snapshot saved = repository.migrate(binding());
        BleServiceState previousProcess = new BleServiceState(new BleOwnership());
        BleServiceState.Run old = previousProcess.reserveDiscovery(true, true, ADDRESS, ID, saved.revision);
        previousProcess.open(old.id, true);
        byte[] original = disk.disk.clone();
        int writes = disk.writes;

        BleServiceState.Run restored = ServiceRecovery.reserve(repository, state, true);

        assertNotNull(restored);
        assertNotEquals(old.id, restored.id);
        assertEquals(ID, restored.expectedDeviceId);
        assertEquals(ADDRESS, restored.address);
        assertEquals(saved.revision, restored.bindingRevision);
        assertTrue(restored.discovery);
        assertEquals("service", ownership.owner());
        assertTrue(state.open(restored.id, true));
        assertEquals("connecting", state.snapshot(0).get("state"));
        assertArrayEquals(original, disk.disk);
        assertEquals(writes, disk.writes);
    }

    @Test public void absentFileDoesNotMigrateOrReserve() throws Exception {
        assertFalse(repository.read().migrationComplete);
        assertNull(ServiceRecovery.reserve(repository, state, true));
        assertNull(disk.disk);
        assertEquals(0, disk.writes);
        assertEquals("none", ownership.owner());
    }

    @Test public void completedEmptyBindingDoesNotSearchForAnotherDevice() throws Exception {
        repository.migrate(null);
        assertNull(ServiceRecovery.reserve(repository, state, true));
        assertEquals("none", ownership.owner());
        assertNull(repository.read().binding);
    }

    @Test public void corruptBindingFailsWithoutOverwritingOrReserving() {
        disk.disk = new byte[] { 1, 2, 3 };
        byte[] original = disk.disk.clone();
        assertThrows(IOException.class, () -> ServiceRecovery.reserve(repository, state, true));
        assertArrayEquals(original, disk.disk);
        assertEquals(0, disk.writes);
        assertEquals("none", ownership.owner());
    }

    @Test public void unreadableBindingIsAnErrorInsteadOfMissingBinding() {
        disk.readError = true;
        assertThrows(IOException.class, () -> ServiceRecovery.reserve(repository, state, true));
        assertEquals(0, disk.writes);
        assertFalse(state.active());
    }

    @Test public void revokedPermissionsDoNotRestoreOrChangeIntent() throws Exception {
        repository.migrate(binding());
        assertNull(ServiceRecovery.reserve(repository, state, false));
        assertTrue(repository.read().connectionEnabled);
        assertEquals("none", ownership.owner());
    }

    @Test public void permissionRevocationBeforeOpenReleasesReservation() throws Exception {
        repository.migrate(binding());
        BleServiceState.Run restored = ServiceRecovery.reserve(repository, state, true);
        assertFalse(state.open(restored.id, false));
        assertEquals("none", ownership.owner());
        assertFalse(state.active());
    }

    @Test public void trennenPersistsAcrossProcessDeathAndBlocksRecovery() throws Exception {
        repository.migrate(binding());
        BleServiceState.Run restored = ServiceRecovery.reserve(repository, state, true);
        state.open(restored.id, true);
        ServiceBindingActions actions = new ServiceBindingActions(repository, state, (id, reason) -> {
            state.stop(id, reason);
            state.closed(id, true, reason);
        });
        actions.disconnect(restored.id, "Trennen");

        BleServiceState nextProcess = new BleServiceState(new BleOwnership());
        assertNull(ServiceRecovery.reserve(new NativeBindingRepository(disk), nextProcess, true));
        assertFalse(repository.read().connectionEnabled);
        assertFalse(nextProcess.active());
    }

    @Test public void notificationTrennenBeforeRecoveryDisablesSavedIntent() throws Exception {
        NativeBindingRepository.Snapshot saved = repository.migrate(binding());
        ServiceBindingActions actions = new ServiceBindingActions(repository, state, (id, reason) -> fail("No run exists"));
        actions.disconnectSaved(saved.revision);
        assertNull(ServiceRecovery.reserve(repository, state, true));
        assertFalse(repository.read().connectionEnabled);
    }

    @Test public void duplicateRecoveryAndVisibleOpenCannotReserveAnotherSession() throws Exception {
        repository.migrate(binding());
        BleServiceState.Run restored = ServiceRecovery.reserve(repository, state, true);
        assertNull(ServiceRecovery.reserve(repository, state, true));
        assertThrows(IllegalStateException.class, () -> state.reserveDiscovery(true, true, ADDRESS, ID, restored.bindingRevision));
        state.open(restored.id, true);
        state.ready(restored.id, new Codec.Info(1, ID, 31));
        assertNull(ServiceRecovery.reserve(repository, state, true));
        assertEquals(restored.id, state.current().id);
    }

    @Test public void visibleStartWinsAgainstRecoveryWithoutDuplicateOrDiskRead() throws Exception {
        NativeBindingRepository.Snapshot saved = repository.migrate(binding());
        BleServiceState.Run visible = state.reserveDiscovery(true, true, ADDRESS, ID, saved.revision);
        disk.readError = true;
        assertNull(ServiceRecovery.reserve(repository, state, true));
        assertEquals(visible.id, state.current().id);
    }

    @Test public void concurrentRecoveryReservationsAcquireOnlyOneLease() throws Exception {
        repository.migrate(binding());
        ExecutorService workers = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<BleServiceState.Run> first = workers.submit(() -> {
                start.await();
                return ServiceRecovery.reserve(repository, state, true);
            });
            Future<BleServiceState.Run> second = workers.submit(() -> {
                start.await();
                return ServiceRecovery.reserve(repository, state, true);
            });
            start.countDown();
            int reservations = (first.get() == null ? 0 : 1) + (second.get() == null ? 0 : 1);
            assertEquals(1, reservations);
            assertEquals("service", ownership.owner());
        } finally {
            workers.shutdownNow();
        }
    }

    @Test public void normalBridgeReservationStillRequiresVisibleActivity() {
        assertThrows(IllegalStateException.class, () -> state.reserveDiscovery(false, true, ADDRESS, ID, null));
        assertFalse(state.active());
    }
}
