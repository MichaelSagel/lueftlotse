package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;
import static de.lueftlotse.app.ble.NativeBindingRepositoryTest.*;

public class ServiceReconnectTest {
    private static final class Harness implements ServiceReconnect.Port {
        final Memory disk = new Memory();
        final NativeBindingRepository repository = new NativeBindingRepository(disk);
        final BleServiceState state = new BleServiceState(new BleOwnership());
        final ServiceReconnect reconnect = new ServiceReconnect(this);
        final List<Long> delays = new ArrayList<>();
        final List<Runnable> scheduled = new ArrayList<>();
        final List<NativeBindingRepository.Binding> attempts = new ArrayList<>();
        final List<String> terminal = new ArrayList<>();
        final ServiceBindingActions actions = new ServiceBindingActions(repository, state, (id, why) -> {
            state.stop(id, why);
            reconnect.cancel();
            state.closed(id, true, why);
        });
        final BleServiceState.Run run;
        boolean permitted = true;
        int cancelled;

        Harness(boolean newBinding) throws Exception {
            NativeBindingRepository.Snapshot saved = repository.migrate(newBinding ? null : binding());
            run = state.reserve(true, true, ADDRESS, newBinding ? null : ID, saved.revision);
            assertTrue(state.open(run.id, true));
            state.connectionStarted(run.id, "first");
            assertTrue(actions.ready(run.id, new Codec.Info(1, ID, 16)));
            assertTrue(reconnect.ready(repository.read().binding));
        }

        public ServiceReconnect.Timer schedule(Runnable action, long delay) {
            delays.add(delay);
            scheduled.add(action);
            return () -> { cancelled++; };
        }
        public NativeBindingRepository.Binding savedBinding() throws Exception {
            return repository.requireMigrated().binding;
        }
        public boolean permitted() { return permitted; }
        public void connect(NativeBindingRepository.Binding binding) {
            attempts.add(binding);
            state.connectionStarted(run.id, "attempt-" + attempts.size());
        }
        public void terminal(String reason) {
            terminal.add(reason);
            state.stop(run.id, reason);
            state.closed(run.id, true, reason);
        }
        void drop() {
            assertTrue(reconnect.unexpectedClose(true, false));
            state.reconnecting(run.id, "radio lost");
        }
        void fire() { scheduled.get(scheduled.size() - 1).run(); }
    }

    @Test public void unexpectedDropRetriesSavedSensorWithoutAReaderAndKeepsExclusiveRun() throws Exception {
        Harness h = new Harness(false);
        h.drop();
        assertEquals(Arrays.asList(1000L), h.delays);
        assertTrue(h.state.active());
        assertEquals("connecting", h.state.snapshot(0).get("state"));
        assertEquals(true, h.state.snapshot(0).get("reconnecting"));
        assertThrows(IllegalStateException.class, () -> h.state.reserve(true, true, ADDRESS, ID));
        assertTrue(h.attempts.isEmpty());
        h.fire();
        assertEquals(1, h.attempts.size());
        assertEquals(ID, h.attempts.get(0).deviceId);
        assertEquals(ADDRESS, h.attempts.get(0).bleAddress);
        assertTrue(h.repository.read().binding.connectionEnabled);
    }

    @Test public void delayDoublesToCapAndDuplicateTimerDeliveryCannotOpenAnotherAttempt() throws Exception {
        Harness h = new Harness(false);
        for (int i = 0; i < 8; i++) {
            h.drop();
            assertTrue(h.reconnect.unexpectedClose(true, false));
            assertEquals(i + 1, h.scheduled.size());
            h.fire();
            h.fire();
            assertEquals(i + 1, h.attempts.size());
        }
        assertEquals(Arrays.asList(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L, 30000L), h.delays);
    }

    @Test public void successfulHandshakeUpdatesBindingRevisionAndInvalidatesOldAttemptTimer() throws Exception {
        Harness h = new Harness(true);
        assertEquals(h.repository.read().revision, h.run.bindingRevision);
        h.drop();
        h.fire();
        Runnable delivered = h.scheduled.get(0);
        assertTrue(h.actions.ready(h.run.id, new Codec.Info(1, ID, 16)));
        assertTrue(h.reconnect.ready(h.repository.read().binding));
        delivered.run();
        assertEquals(1, h.attempts.size());
        h.drop();
        assertEquals(Arrays.asList(1000L, 1000L), h.delays);
    }

    @Test public void notificationTrennenCancelsTimerAndLateReadyCannotRestoreConnection() throws Exception {
        Harness h = new Harness(false);
        h.drop();
        h.actions.disconnect(h.run.id, "notification Trennen");
        assertEquals(1, h.cancelled);
        h.fire();
        assertTrue(h.attempts.isEmpty());
        assertFalse(h.actions.ready(h.run.id, new Codec.Info(1, ID, 16)));
        assertFalse(h.reconnect.ready(binding()));
        assertFalse(h.repository.read().binding.connectionEnabled);
    }

    @Test public void trennenDuringAttemptRejectsLateConnectionAndDoesNotScheduleAgain() throws Exception {
        Harness h = new Harness(false);
        h.drop();
        h.fire();
        assertTrue(h.state.matchesConnection(h.run.id, "attempt-1"));
        h.actions.disconnect(h.run.id, "UI Trennen");
        assertFalse(h.state.matchesConnection(h.run.id, "attempt-1"));
        assertFalse(h.actions.ready(h.run.id, new Codec.Info(1, ID, 16)));
        assertFalse(h.reconnect.unexpectedClose(true, false));
        h.fire();
        assertEquals(1, h.attempts.size());
        assertEquals(1, h.scheduled.size());
    }

    @Test public void failedIntentWriteStillCancelsRetriesEvenIfDiskRemainsEnabled() throws Exception {
        Harness h = new Harness(false);
        h.drop();
        h.disk.failBeforeWrite = true;
        assertThrows(java.io.IOException.class, () -> h.actions.disconnect(h.run.id, "Trennen"));
        h.fire();
        assertTrue(h.attempts.isEmpty());
        assertTrue(h.repository.read().binding.connectionEnabled);
        assertFalse(h.reconnect.unexpectedClose(true, false));
    }

    @Test public void forgetCancelsRetryAndLateCallbacksCannotResurrectTombstone() throws Exception {
        Harness h = new Harness(false);
        h.drop();
        h.actions.forget(h.repository.read().revision);
        h.fire();
        assertTrue(h.attempts.isEmpty());
        assertNull(h.repository.read().binding);
        assertFalse(h.actions.ready(h.run.id, new Codec.Info(1, ID, 16)));
    }

    @Test public void savedIntentPermissionAndStorageAreRecheckedAtTimerDelivery() throws Exception {
        for (int fault = 0; fault < 4; fault++) {
            Harness h = new Harness(false);
            h.drop();
            if (fault == 0) h.repository.disableConnection();
            if (fault == 1) h.permitted = false;
            if (fault == 2) h.disk.readError = true;
            if (fault == 3) h.repository.forget(h.repository.read().revision);
            h.fire();
            assertTrue(h.attempts.isEmpty());
            assertEquals(1, h.terminal.size());
            assertFalse(h.reconnect.unexpectedClose(true, false));
        }
    }

    @Test public void identityMismatchAndUncertainCleanupAreTerminalNotRetryable() throws Exception {
        Harness identity = new Harness(false);
        assertFalse(identity.reconnect.unexpectedClose(true, true));
        assertFalse(identity.reconnect.unexpectedClose(true, false));
        assertTrue(identity.scheduled.isEmpty());
        Harness uncertain = new Harness(false);
        assertFalse(uncertain.reconnect.unexpectedClose(false, false));
        assertTrue(uncertain.scheduled.isEmpty());
    }

    @Test public void creatingServicePolicyDoesNotReconnectFromPersistedIntentOrInitialFailure() throws Exception {
        Harness h = new Harness(false);
        ServiceReconnect freshProcess = new ServiceReconnect(h);
        assertTrue(h.scheduled.isEmpty());
        assertFalse(freshProcess.unexpectedClose(true, false));
        assertTrue(h.scheduled.isEmpty());
    }

    @Test public void oldPhysicalCallbackIsRejectedEvenWithinTheSameLogicalRun() throws Exception {
        Harness h = new Harness(false);
        assertTrue(h.state.matchesConnection(h.run.id, "first"));
        h.drop();
        assertFalse(h.state.matchesConnection(h.run.id, "first"));
        h.fire();
        assertFalse(h.state.matchesConnection(h.run.id, "first"));
        assertTrue(h.state.matchesConnection(h.run.id, "attempt-1"));
    }
}
