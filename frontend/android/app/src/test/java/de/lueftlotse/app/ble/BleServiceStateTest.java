package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import de.lueftlotse.ble.UInt64;
import org.junit.Test;
import java.util.Map;
import static org.junit.Assert.*;

public class BleServiceStateTest {
    private static final String ADDRESS = "01:23:45:67:89:AB", ID = "00112233-4455-4677-8899-aabbccddeeff";
    private static Codec.Message sample() { return Codec.message(0x8a, "bootId", ID, "sampleCounter", UInt64.MAX, "uptimeMs", UInt64.MAX, "ppm", 2100); }
    private final BleOwnership owners = new BleOwnership();
    private final BleServiceState state = new BleServiceState(owners);
    private BleServiceState.Run reserve() { return state.reserve(true, true, ADDRESS, ID); }
    private BleServiceState.Run ready() {
        BleServiceState.Run run = reserve(); assertTrue(state.open(run.id, true)); state.ready(run.id, new Codec.Info(1, ID, 31)); return run;
    }
    @Test public void noAutomaticStartOrOwnershipOnCreationAndReads() {
        assertFalse(state.active()); assertEquals("none", owners.owner()); assertEquals("stopped", state.snapshot(0).get("state"));
        assertNull(state.snapshot(9000).get("lastSample")); assertFalse(state.open("unknown", true));
    }
    @Test public void visibleActivityAndPermissionsAreBothRequiredBeforeReservation() {
        assertThrows(IllegalStateException.class, () -> state.reserve(false, true, ADDRESS, ID));
        assertThrows(IllegalStateException.class, () -> state.reserve(true, false, ADDRESS, ID));
        assertEquals("none", owners.owner()); assertFalse(state.active());
    }
    @Test public void invalidArgumentsDoNotAcquireOwnership() {
        assertThrows(IllegalArgumentException.class, () -> state.reserve(true, true, "bad", ID));
        assertThrows(IllegalArgumentException.class, () -> state.reserve(true, true, ADDRESS, "bad"));
        assertEquals("none", owners.owner());
    }
    @Test public void serviceRechecksPermissionsAndNeverOpensAfterRevocation() {
        BleServiceState.Run run = reserve(); assertFalse(state.open(run.id, false)); assertEquals("none", owners.owner());
        assertEquals("error", state.snapshot(0).get("state")); assertFalse(state.open(run.id, true));
    }
    @Test public void legacyConnectPendingBlocksServiceStart() {
        LegacyBleGate gate = new LegacyBleGate(owners); LegacyBleGate.Attempt legacy = gate.connect(ADDRESS);
        assertThrows(IllegalStateException.class, this::reserve); gate.connectSettled(legacy);
        assertThrows(IllegalStateException.class, this::reserve); gate.disconnected(legacy); assertNotNull(reserve());
    }
    @Test public void serviceReservationBlocksLegacyBeforeGattOpensAndDuringCleanup() {
        BleServiceState.Run run = reserve(); LegacyBleGate gate = new LegacyBleGate(owners);
        assertThrows(IllegalStateException.class, () -> gate.connect(ADDRESS)); assertTrue(state.open(run.id, true));
        assertTrue(state.stop(run.id, "Trennen")); assertThrows(IllegalStateException.class, () -> gate.connect(ADDRESS));
        state.closed(run.id, true, "closed"); assertNotNull(gate.connect(ADDRESS));
    }
    @Test public void duplicateStartsDoNotCreateSecondSession() {
        BleServiceState.Run run = reserve(); assertThrows(IllegalStateException.class, this::reserve);
        assertTrue(state.open(run.id, true)); assertFalse(state.open(run.id, true));
        state.ready(run.id, new Codec.Info(1, ID, 31)); assertFalse(state.open(run.id, true));
    }
    @Test public void cancelPendingStartInvalidatesLateStartIntent() {
        BleServiceState.Run run = reserve(); assertTrue(state.stop(run.id, "cancel")); assertFalse(state.open(run.id, true));
        assertEquals("none", owners.owner()); BleServiceState.Run next = reserve();
        assertFalse(state.open(run.id, true)); assertTrue(state.open(next.id, true));
    }
    @Test public void startFailureOrDeadlineReleasesOnlyUnopenedRun() {
        BleServiceState.Run old = reserve(); state.failBeforeOpen(old.id, "timeout"); assertEquals("none", owners.owner());
        BleServiceState.Run next = reserve(); state.open(next.id, true);
        state.failBeforeOpen(old.id, "late failure"); state.failBeforeOpen(next.id, "late deadline"); assertTrue(state.matches(next.id));
    }
    @Test public void notificationDisconnectIsIdempotentAndOldActionCannotStopNewRun() {
        BleServiceState.Run first = ready(); assertTrue(state.stop(first.id, "Über Benachrichtigung getrennt"));
        assertFalse(state.stop(first.id, "again")); assertEquals("stopping", state.snapshot(0).get("state"));
        state.closed(first.id, true, "closed"); BleServiceState.Run second = ready();
        assertFalse(state.stop(first.id, "stale notification")); assertEquals("ready", state.snapshot(0).get("state")); assertTrue(state.matches(second.id));
    }
    @Test public void lateReadyLiveAndCloseCallbacksDoNotAffectNewGeneration() {
        BleServiceState.Run old = ready(); state.stop(old.id, "stop"); state.closed(old.id, true, "closed"); BleServiceState.Run next = ready();
        state.ready(old.id, new Codec.Info(1, ID, 31)); state.live(old.id, sample(), 500); state.closed(old.id, true, "late");
        assertTrue(state.matches(next.id)); assertNull(state.snapshot(1000).get("lastSample")); assertEquals("ready", state.snapshot(1000).get("state"));
    }
    @Test public void stoppingRejectsLateLiveBeforePhysicalCloseAndPreservesOwnership() {
        BleServiceState.Run run = ready(); state.stop(run.id, "destroy"); state.live(run.id, sample(), 1000);
        assertNull(state.snapshot(2000).get("lastSample")); assertEquals("service", owners.owner());
        state.closed(run.id, true, "done"); assertEquals("none", owners.owner());
    }
    @Test public void repeatedStateReadsNeverRefreshArrivalAndAllUint64AreStrings() {
        BleServiceState.Run run = ready(); state.live(run.id, sample(), 100);
        Map<String, Object> first = state.snapshot(1000), later = state.snapshot(15100);
        assertSame(first.get("lastSample"), later.get("lastSample"));
        Map<?, ?> data = (Map<?, ?>) later.get("lastSample");
        assertEquals("100", data.get("receivedAtElapsedMs")); assertEquals("18446744073709551615", data.get("sampleCounter"));
        assertEquals("18446744073709551615", data.get("uptimeMs")); assertEquals(true, first.get("sampleAvailable"));
        assertEquals(false, later.get("sampleAvailable")); assertEquals("15100", later.get("nowElapsedMs"));
    }
    @Test public void serviceStateSurvivesNewBridgeReaderWithoutNewSessionOrNewTimestamp() {
        BleServiceState.Run run = ready(); state.live(run.id, sample(), 50);
        java.util.function.Supplier<Map<String, Object>> oldPage = () -> state.snapshot(100);
        java.util.function.Supplier<Map<String, Object>> recreatedPage = () -> state.snapshot(200);
        assertEquals(oldPage.get().get("runId"), recreatedPage.get().get("runId"));
        assertSame(oldPage.get().get("lastSample"), recreatedPage.get().get("lastSample")); assertTrue(state.matches(run.id));
    }
    @Test public void disconnectKeepsLastArrivalButMakesSampleUnavailable() {
        BleServiceState.Run run = ready(); state.live(run.id, sample(), 20); state.stop(run.id, "stop"); state.closed(run.id, true, "closed");
        assertEquals(false, state.snapshot(21).get("sampleAvailable")); assertEquals("20", ((Map<?, ?>) state.snapshot(21).get("lastSample")).get("receivedAtElapsedMs"));
        reserve(); assertNull(state.snapshot(22).get("lastSample"));
    }
    @Test public void uncertainCleanupNeverReleasesOwnershipOrStartsSecondGatt() {
        BleServiceState.Run run = ready(); state.stop(run.id, "stop"); state.closed(run.id, false, "close failed");
        assertEquals("error", state.snapshot(0).get("state")); assertEquals("service", owners.owner()); assertThrows(IllegalStateException.class, this::reserve);
        assertThrows(IllegalStateException.class, () -> new LegacyBleGate(owners).connect(ADDRESS));
        state.closed(run.id, true, "duplicate stale completion"); assertEquals("service", owners.owner());
    }
    @Test public void sensorErrorInvalidatesCacheUntilANewSampleWithoutRefreshingItsTime() {
        BleServiceState.Run run = ready(); state.live(run.id, sample(), 100); state.sensorError(run.id);
        assertEquals(false, state.snapshot(101).get("sampleAvailable"));
        assertEquals("100", ((Map<?, ?>) state.snapshot(101).get("lastSample")).get("receivedAtElapsedMs"));
        state.live(run.id, sample(), 200); assertEquals(true, state.snapshot(201).get("sampleAvailable"));
        state.sensorError("old-run"); assertEquals(true, state.snapshot(202).get("sampleAvailable"));
    }
}
