package de.lueftlotse.app.ble;

import java.util.*;
import java.util.function.Consumer;
import org.junit.Test;
import static org.junit.Assert.*;
import static de.lueftlotse.app.ble.NativeBindingRepositoryTest.*;

public class ServiceDiscoveryTest {
    private static final class Harness implements ServiceDiscovery.Port {
        final List<Runnable> timers = new ArrayList<>();
        final List<Long> delays = new ArrayList<>();
        final List<String> addresses = new ArrayList<>(), identities = new ArrayList<>(), errors = new ArrayList<>();
        Consumer<ServiceDiscovery.Candidate> found;
        Consumer<String> failed;
        List<ServiceDiscovery.Candidate> choices = Collections.emptyList();
        boolean scanning, enabled = true;
        String mode;
        int stops;
        public ServiceDiscovery.Timer schedule(Runnable action, long delay) {
            timers.add(action);
            delays.add(delay);
            return () -> { };
        }
        public void scan(Consumer<ServiceDiscovery.Candidate> found, Consumer<String> failed) {
            assertFalse(scanning);
            scanning = true;
            this.found = found;
            this.failed = failed;
        }
        public void stopScan() { scanning = false; stops++; }
        public boolean enabled() { return enabled; }
        public void connect(String address, String expected) {
            assertFalse(scanning);
            addresses.add(address);
            identities.add(expected);
        }
        public void state(String mode, List<ServiceDiscovery.Candidate> choices) {
            this.mode = mode;
            this.choices = choices;
        }
        public void terminal(String error) { errors.add(error); }
        void timer() { timers.remove(0).run(); }
        void result(String address) { found.accept(new ServiceDiscovery.Candidate(address, "Lüftlotse")); }
    }
    @Test public void savedDirectFailureSearchesSeriallyAndKeepsExpectedUuid() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, binding());
        policy.start();
        assertEquals(Collections.singletonList(ADDRESS), h.addresses);
        policy.closed(true, false);
        assertFalse(h.scanning);
        h.timer();
        assertTrue(h.scanning);
        h.result(NEXT);
        h.timer();
        assertEquals(Arrays.asList(ADDRESS, NEXT), h.addresses);
        assertEquals(Arrays.asList(ID, ID), h.identities);
        assertFalse(h.scanning);
    }
    @Test public void noBindingConnectsOneDeduplicatedCandidateWithoutSelection() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, null);
        policy.start();
        h.result(ADDRESS);
        h.result(ADDRESS);
        h.timer();
        assertEquals(Collections.singletonList(ADDRESS), h.addresses);
        assertNull(h.identities.get(0));
        assertTrue(h.choices.isEmpty());
    }
    @Test public void severalSensorsRequireSelectionAndRejectStaleAddresses() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, null);
        policy.start();
        h.result(ADDRESS);
        h.result(NEXT);
        h.timer();
        assertEquals("choice", h.mode);
        assertEquals(2, h.choices.size());
        assertTrue(h.addresses.isEmpty());
        assertThrows(IllegalStateException.class, () -> policy.choose("00:00:00:00:00:00"));
        policy.choose(NEXT);
        assertEquals(Collections.singletonList(NEXT), h.addresses);
        assertThrows(IllegalStateException.class, () -> policy.choose(ADDRESS));
    }
    @Test public void emptySearchBacksOffWithCapAndNoParallelScan() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, null);
        policy.start();
        for (int i = 0; i < 7; i++) {
            h.timer(); // End window, schedule a pause.
            assertFalse(h.scanning);
            h.timer(); // Start next window.
            assertTrue(h.scanning);
        }
        assertEquals(Arrays.asList(8000L, 1000L, 8000L, 2000L, 8000L, 4000L,
            8000L, 8000L, 8000L, 16000L, 8000L, 30000L, 8000L, 30000L, 8000L), h.delays);
    }
    @Test public void trennenCancelsScanTimerAndLateResults() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, null);
        policy.start();
        Consumer<ServiceDiscovery.Candidate> late = h.found;
        policy.cancel();
        late.accept(new ServiceDiscovery.Candidate(ADDRESS, "late"));
        h.timer();
        assertFalse(h.scanning);
        assertTrue(h.addresses.isEmpty());
        assertEquals(1, h.stops);
    }
    @Test public void cancellationDuringAttemptNeverRestartsAfterLateCloseOrReady() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, binding());
        policy.start();
        policy.cancel();
        policy.closed(true, false);
        policy.ready(binding());
        assertTrue(h.timers.isEmpty());
        assertEquals(1, h.addresses.size());
    }
    @Test public void wrongIdentityIsQuarantinedWithoutSwitchingSavedSensor() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, binding());
        policy.start();
        policy.closed(true, true);
        h.timer();
        h.result(ADDRESS);
        h.result(NEXT);
        h.timer();
        assertEquals(Arrays.asList(ADDRESS, NEXT), h.addresses);
        assertEquals(ID, h.identities.get(1));
    }
    @Test public void disablingIntentDuringPausePreventsAnotherScan() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, binding());
        policy.start();
        policy.closed(true, false);
        h.enabled = false;
        h.timer();
        assertFalse(h.scanning);
        assertEquals(1, h.errors.size());
    }
    @Test public void permissionLossAtScanEndDoesNotStartGatt() {
        Harness h = new Harness();
        ServiceDiscovery policy = new ServiceDiscovery(h, null);
        policy.start();
        h.result(ADDRESS);
        h.enabled = false;
        h.timer();
        assertTrue(h.addresses.isEmpty());
        assertFalse(h.scanning);
        assertEquals(1, h.errors.size());
    }
}
