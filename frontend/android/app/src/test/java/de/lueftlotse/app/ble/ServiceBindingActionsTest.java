package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.io.IOException;
import java.math.BigInteger;
import org.junit.Test;
import static org.junit.Assert.*;
import static de.lueftlotse.app.ble.NativeBindingRepositoryTest.*;

public class ServiceBindingActionsTest {
    private final Memory disk = new Memory();
    private final NativeBindingRepository repo = new NativeBindingRepository(disk);
    private final BleServiceState state = new BleServiceState(new BleOwnership());
    private final ServiceBindingActions actions = new ServiceBindingActions(repo, state, (id, reason) -> {
        disk.trace.add("close"); state.stop(id, reason); state.closed(id, true, reason);
    });
    private BleServiceState.Run connecting(boolean existing) throws Exception {
        NativeBindingRepository.Snapshot saved = repo.migrate(existing ? binding() : null);
        BleServiceState.Run run = state.reserve(true, true, NEXT, existing ? ID : null, saved.revision);
        state.open(run.id, true); disk.trace.clear(); return run;
    }
    @Test public void newIdentityAndAddressAreNotSavedBeforeStatus() throws Exception {
        BleServiceState.Run run = connecting(false); assertNull(repo.read().binding);
        assertTrue(actions.ready(run.id, new Codec.Info(1, ID, 31)));
        assertEquals(ID, repo.read().binding.deviceId); assertEquals(NEXT, repo.read().binding.bleAddress); assertEquals("ready", state.snapshot(0).get("state"));
    }
    @Test public void uuidMismatchClosesWithoutReplacingSavedIdentityOrAddress() throws Exception {
        BleServiceState.Run run = connecting(true);
        assertFalse(actions.ready(run.id, new Codec.Info(1, OTHER, 31)));
        assertEquals(ADDRESS, repo.read().binding.bleAddress); assertEquals(ID, repo.read().binding.deviceId);
        assertEquals(java.util.Arrays.asList("close"), disk.trace); assertNotNull(state.snapshot(0).get("bindingError"));
    }
    @Test public void disconnectCommitsDisabledIntentBeforeClosingIncludingNotificationPath() throws Exception {
        BleServiceState.Run run = connecting(true); actions.disconnect(run.id, "Über Benachrichtigung getrennt");
        assertEquals(java.util.Arrays.asList("write", "close"), disk.trace); assertFalse(new NativeBindingRepository(disk).read().binding.connectionEnabled);
        assertFalse(actions.ready(run.id, new Codec.Info(1, ID, 31))); assertEquals(ADDRESS, repo.read().binding.bleAddress);
    }
    @Test public void failedDisconnectWriteStillClosesAndReportsAnErrorAfterCleanup() throws Exception {
        BleServiceState.Run run = connecting(true); disk.failBeforeWrite = true;
        assertThrows(IOException.class, () -> actions.disconnect(run.id, "Trennen"));
        assertEquals(java.util.Arrays.asList("write", "close"), disk.trace); assertEquals("stopped", state.snapshot(0).get("state"));
        assertNotNull(state.snapshot(0).get("bindingError")); assertTrue(repo.read().binding.connectionEnabled);
    }
    @Test public void failedReadAlsoClosesWithoutClaimingIntentWasSaved() throws Exception {
        BleServiceState.Run run = connecting(true); disk.readError = true;
        assertThrows(IOException.class, () -> actions.disconnect(run.id, "Trennen"));
        assertEquals(java.util.Arrays.asList("close"), disk.trace); assertNotNull(state.snapshot(0).get("bindingError"));
    }
    @Test public void storageFailureAfterStatusNeverReportsReady() throws Exception {
        BleServiceState.Run run = connecting(false); disk.failBeforeWrite = true;
        assertFalse(actions.ready(run.id, new Codec.Info(1, ID, 31)));
        assertEquals("stopped", state.snapshot(0).get("state")); assertNull(repo.read().binding); assertNotNull(state.snapshot(0).get("bindingError"));
    }
    @Test public void forgetRevokesPendingHandshakeAndOldMigrationCannotResurrectSensor() throws Exception {
        BleServiceState.Run run = connecting(true); actions.forget(repo.read().revision);
        assertFalse(actions.ready(run.id, new Codec.Info(1, ID, 31))); assertNull(repo.migrate(binding()).binding);
        assertEquals(java.util.Arrays.asList("write", "close"), disk.trace); assertTrue(repo.read().migrationComplete);
    }
    @Test public void failedForgetClosesButRetainsBindingAndReportsFailure() throws Exception {
        connecting(true); disk.failBeforeWrite = true;
        assertThrows(IOException.class, () -> actions.forget(BigInteger.ONE));
        assertEquals("stopped", state.snapshot(0).get("state")); assertNotNull(repo.read().binding); assertNotNull(state.snapshot(0).get("bindingError"));
    }
    @Test public void staleForgetAndOldRunCallbacksCannotChangeNewSession() throws Exception {
        BleServiceState.Run old = connecting(true); actions.disconnect(old.id, "old");
        NativeBindingRepository.Snapshot saved = repo.read();
        BleServiceState.Run current = state.reserve(true, true, NEXT, ID, saved.revision); state.open(current.id, true); disk.trace.clear();
        actions.disconnect(old.id, "late"); assertFalse(actions.ready(old.id, new Codec.Info(1, ID, 31)));
        assertThrows(NativeBindingRepository.StaleRevision.class, () -> actions.forget(BigInteger.ONE));
        assertTrue(disk.trace.isEmpty()); assertTrue(state.matches(current.id));
    }
    @Test public void explicitDisconnectAfterRadioLossCanStillDisableIntentIdempotently() throws Exception {
        BleServiceState.Run run = connecting(true); state.closed(run.id, true, "radio lost");
        actions.disconnect(run.id, "Trennen"); BigInteger revision = repo.read().revision;
        actions.disconnect(run.id, "Trennen"); assertEquals(revision, repo.read().revision); assertFalse(repo.read().binding.connectionEnabled);
    }
    @Test public void trennenAfterProcessRestartDisablesSavedIntentWithoutOpeningGatt() throws Exception {
        NativeBindingRepository.Snapshot saved = repo.migrate(binding()); disk.trace.clear();
        actions.disconnectSaved(saved.revision);
        assertFalse(new NativeBindingRepository(disk).read().binding.connectionEnabled);
        assertEquals(java.util.Arrays.asList("write"), disk.trace); assertNull(state.current());
        assertThrows(NativeBindingRepository.StaleRevision.class, () -> actions.disconnectSaved(saved.revision));
    }
    @Test public void staleSavedOnlyDisconnectCannotAffectANewRun() throws Exception {
        BleServiceState.Run run = connecting(true);
        assertThrows(IllegalStateException.class, () -> actions.disconnectSaved(repo.read().revision));
        assertTrue(state.matches(run.id)); assertTrue(repo.read().binding.connectionEnabled); assertTrue(disk.trace.isEmpty());
    }
}
