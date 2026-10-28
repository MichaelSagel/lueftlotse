package de.lueftlotse.ble.transport;

import de.lueftlotse.ble.*;
import org.junit.Test;
import java.util.*;
import java.util.concurrent.*;
import static de.lueftlotse.ble.transport.FakeGatt.*;
import static org.junit.Assert.*;

public class GattTransportTest {
    @Test public void connectDiscoveryInfoCccdAndHandshakeAreStrictlySequential() {
        Harness h = new Harness(); h.start(); assertEquals(Collections.singletonList("connect"), h.boundary.calls);
        h.link.connected(); assertEquals("discover", h.link.pending); h.link.discovered(); assertEquals("info", h.link.pending);
        h.link.read(info()); assertEquals("cccd", h.link.pending); assertTrue(h.link.sent.isEmpty());
        assertEquals(Arrays.asList("connect", "discover", "profile", "info", "notify", "cccd"), h.boundary.calls);
        h.link.send(sample(1)); assertTrue(h.live.isEmpty()); h.link.subscribed(); assertEquals(1, h.link.sent.size());
        assertEquals(GattTransport.State.HANDSHAKE, h.connection.state()); assertFalse(h.connection.ready().toCompletableFuture().isDone());
        h.link.send(status(0)); assertFalse(h.connection.ready().toCompletableFuture().isDone());
        h.link.send(sample(2)); h.link.ackWrite(); assertEquals(GattTransport.State.READY, h.connection.state()); assertTrue(h.live.isEmpty());
        h.link.send(sample(3)); assertEquals(1, h.live.size()); assertEquals(n(3), h.live.get(0).big("sampleCounter"));
    }
    @Test public void callbackDuringConnectReturnIsMarshalledAndCannotRaceHandleAssignment() {
        Harness h = new Harness();
        h.boundary.connectHook = () -> h.boundary.links.get(0).callback.connection(0, GattBoundary.CONNECTED);
        h.start(); assertEquals(Arrays.asList("connect", "discover"), h.boundary.calls); assertEquals(GattTransport.State.DISCOVERING, h.connection.state());
    }
    @Test public void infoAndEventsAreCopiedBeforeQueuedProcessing() {
        Harness h = new Harness(); h.start(); h.link.connected(); h.link.discovered();
        byte[] bytes = info(); h.link.pending = null; h.link.callback.info(0, bytes); Arrays.fill(bytes, (byte) 0); h.loop.run();
        assertEquals(GattTransport.State.SUBSCRIBING, h.connection.state()); h.link.subscribed(); h.link.finishWrites();
        for (byte[] frame : Wire.fragment(status(0), h.link.eventId++, Wire.Direction.EVENTS)) { h.link.callback.events(frame); Arrays.fill(frame, (byte) 0); }
        h.loop.run(); assertEquals(GattTransport.State.READY, h.connection.state());
        for (byte[] frame : Wire.fragment(sample(1), h.link.eventId++, Wire.Direction.EVENTS)) { h.link.callback.events(frame); Arrays.fill(frame, (byte) 0); }
        h.loop.run(); assertEquals(1, h.live.size());
    }
    @Test public void secondSessionIsRejectedWhileQueuedConnectingReadyAndCancelling() {
        Harness h = new Harness(); h.connection = h.transport.connect(ADDRESS, ID);
        assertThrows(IllegalStateException.class, () -> h.transport.connect(ADDRESS, ID)); h.loop.run(); h.link = h.boundary.links.get(0);
        assertThrows(IllegalStateException.class, () -> h.transport.connect(ADDRESS, ID));
        h.link.connected(); h.link.discovered(); h.link.read(info()); h.link.subscribed(); h.link.finishWrites(); h.link.send(status(0));
        assertThrows(IllegalStateException.class, () -> h.transport.connect(ADDRESS, ID)); h.connection.cancel();
        assertThrows(IllegalStateException.class, () -> h.transport.connect(ADDRESS, ID)); h.loop.run(); h.closed();
        h.start(); assertEquals(2, h.boundary.links.size());
    }
    @Test public void cancelBeforeConnectNeverOpensGatt() {
        Harness h = new Harness(); h.connection = h.transport.connect(ADDRESS, ID); h.connection.cancel(); h.loop.run();
        assertTrue(h.boundary.links.isEmpty()); assertEquals(GattTransport.State.CLOSED, h.connection.state()); assertEquals(1, h.reasons.size());
        assertTrue(h.connection.ready().toCompletableFuture().isCompletedExceptionally());
    }
    @Test public void cancelWhileConnectReturnsClosesLateHandleAndRejectsLateSuccess() {
        Harness h = new Harness(); h.boundary.connectHook = () -> h.connection.cancel(); h.start(); h.closed();
        h.link.callback.connection(0, GattBoundary.CONNECTED); h.loop.run(); h.closed();
        assertEquals(Arrays.asList("connect", "disconnect", "close"), h.boundary.calls);
    }
    @Test public void synchronousConnectReturningAfterDeadlineIsClosed() {
        Harness h = new Harness(); h.boundary.connectHook = () -> h.loop.time += 10000; h.start(); h.closed();
        assertTrue(h.connection.ready().toCompletableFuture().isCompletedExceptionally());
    }
    @Test public void lateCallbacksFromCancelledAttemptCannotAdvanceNewConnection() {
        Harness h = new Harness(); h.handshake(); Boundary.Link old = h.link; GattTransport.Connection oldConnection = h.connection; Sent oldWrite = old.sent.get(0);
        oldConnection.cancel(); h.loop.run(); h.closed(); h.start();
        old.callback.connection(0, GattBoundary.CONNECTED); old.callback.discovered(0); old.callback.info(0, info()); old.callback.subscribed(0);
        old.callback.written(oldWrite.token, 0); old.send(status(0)); old.callback.connection(133, GattBoundary.DISCONNECTED); h.loop.run();
        assertEquals(GattTransport.State.CONNECTING, h.connection.state()); assertEquals(0, h.link.closes); assertEquals(1, old.closes);
        assertTrue(h.transport.requestStatus(oldConnection).toCompletableFuture().isCompletedExceptionally());
        oldConnection.cancel(); h.loop.run(); assertEquals(GattTransport.State.CONNECTING, h.connection.state());
    }
    @Test public void connectNullAndPermissionFailureDoNotHoldSlot() {
        for (boolean returnsNull : new boolean[]{true, false}) {
            Harness h = new Harness(); h.boundary.returnNull = returnsNull; h.boundary.throwing = returnsNull ? null : "connect";
            h.connection = h.transport.connect(ADDRESS, ID); h.loop.run(); assertEquals(GattTransport.State.CLOSED, h.connection.state());
            assertTrue(h.connection.ready().toCompletableFuture().isCompletedExceptionally());
            h.boundary.returnNull = false; h.boundary.throwing = null; h.start(); assertEquals(GattTransport.State.CONNECTING, h.connection.state());
        }
    }
    @Test public void rejectedNativeInitiationsAndMissingProfileCloseImmediately() {
        for (String reject : new String[]{"discover", "profile", "info", "notify", "cccd", "control-with-response"}) {
            Harness h = new Harness(); h.boundary.reject = reject; h.start(); h.link.connected();
            if (h.connection.state() != GattTransport.State.CLOSED) h.link.discovered();
            if (h.connection.state() != GattTransport.State.CLOSED) h.link.read(info());
            if (h.connection.state() != GattTransport.State.CLOSED) h.link.subscribed(); h.closed();
            assertTrue(h.connection.ready().toCompletableFuture().isCompletedExceptionally());
        }
    }
    @Test public void permissionExceptionsDuringOperationsAlsoClose() {
        for (String throwing : new String[]{"discover", "profile", "info", "notify", "cccd", "control-with-response"}) {
            Harness h = new Harness(); h.boundary.throwing = throwing; h.start(); h.link.connected();
            if (h.connection.state() != GattTransport.State.CLOSED) h.link.discovered();
            if (h.connection.state() != GattTransport.State.CLOSED) h.link.read(info());
            if (h.connection.state() != GattTransport.State.CLOSED) h.link.subscribed(); h.closed();
        }
    }
    @Test public void nonSuccessCallbackStatusesNeverAdvanceNextOperation() {
        for (int phase = 0; phase < 5; phase++) {
            Harness h = new Harness(); h.start();
            if (phase == 0) h.link.callback.connection(133, GattBoundary.CONNECTED);
            else { h.link.connected();
                if (phase == 1) h.link.callback.discovered(133);
                else { h.link.discovered();
                    if (phase == 2) h.link.callback.info(133, info());
                    else { h.link.read(info());
                        if (phase == 3) h.link.callback.subscribed(133);
                        else { h.link.subscribed(); h.link.callback.written(h.link.sent.get(0).token, 133); }
                    }
                }
            }
            h.loop.run(); h.closed(); assertTrue(h.connection.ready().toCompletableFuture().isCompletedExceptionally());
        }
    }
    @Test public void eachAsynchronousOperationHasFiniteTimeoutAndLateCallbacksAreIgnored() {
        for (int phase = 0; phase < 6; phase++) {
            Harness h = new Harness(); h.start();
            if (phase >= 1) h.link.connected(); if (phase >= 2) h.link.discovered(); if (phase >= 3) h.link.read(info());
            if (phase >= 4) h.link.subscribed(); if (phase >= 5) h.link.finishWrites();
            long timeout = phase == 0 ? 10000 : 5000; h.loop.advance(timeout - 1); assertNotEquals(GattTransport.State.CLOSED, h.connection.state());
            // A delayed timer may run after the deadline; the callback path must enforce it too.
            h.loop.time++;
            if (phase == 0) h.link.callback.connection(0, GattBoundary.CONNECTED);
            if (phase == 1) h.link.callback.discovered(0);
            if (phase == 2) h.link.callback.info(0, info());
            if (phase == 3) h.link.callback.subscribed(0);
            if (phase == 4) h.link.callback.written(h.link.sent.get(0).token, 0);
            if (phase == 5) h.link.send(status(0));
            h.loop.run(); h.closed();
            h.link.callback.discovered(0); h.link.callback.info(0, info()); h.link.callback.subscribed(0); h.loop.run(); h.closed();
        }
    }
    @Test public void idleTicksExpireMissingHandshakeAndIncompleteEventsWithoutCallbacks() {
        Harness h = new Harness(); h.handshake(); h.link.finishWrites(); h.loop.advance(5000); h.closed();
        h.ready(); byte[] first = Wire.fragment(sample(1), h.link.eventId++, Wire.Direction.EVENTS).get(0); h.link.callback.events(first); h.loop.run();
        h.loop.advance(5000); h.closed();
    }
    @Test public void invalidInfoAndWrongExpectedUuidNeverSubscribe() {
        for (byte[] bad : new byte[][]{null, new byte[19], new byte[21], Codec.encodeInfo(new Codec.Info(1, OTHER, 31)), invalidVersion()}) {
            Harness h = new Harness(); h.start(); h.link.connected(); h.link.discovered(); h.link.read(bad); h.closed();
            assertFalse(h.boundary.calls.contains("notify"));
        }
    }
    private static byte[] invalidVersion() { byte[] bytes = info(); bytes[1] = 2; return bytes; }
    @Test public void unexpectedPhaseAndStaleWriteTokenAreNotAccepted() {
        Harness h = new Harness(); h.start(); h.link.callback.subscribed(0); h.loop.run(); h.closed();
        h.handshake(); h.link.callback.written("old-token", 0); h.loop.run(); h.closed();
        h.start(); h.link.callback.failure("Wrong characteristic/service/descriptor"); h.loop.run(); h.closed();
    }
    @Test public void disconnectAtEveryStageCleansExactlyOnceIncludingReady() {
        for (int phase = 0; phase < 6; phase++) {
            Harness h = new Harness(); h.start(); if (phase >= 1) h.link.connected(); if (phase >= 2) h.link.discovered(); if (phase >= 3) h.link.read(info());
            if (phase >= 4) h.link.subscribed(); if (phase >= 5) { h.link.finishWrites(); h.link.send(status(0)); }
            h.link.callback.connection(0, GattBoundary.DISCONNECTED); h.loop.run(); h.closed(); h.connection.cancel();
            h.link.callback.connection(133, GattBoundary.DISCONNECTED); h.loop.advance(30000); h.closed(); assertEquals(1, h.reasons.size());
        }
    }
    @Test public void closeStillRunsWhenDisconnectThrowsAndSlotCanBeReused() {
        Harness h = new Harness(); h.ready(); h.boundary.throwing = "disconnect"; h.connection.cancel(); h.loop.run(); h.closed();
        h.boundary.throwing = null; h.start(); assertEquals(2, h.boundary.links.size());
    }
    @Test public void failedNativeCloseDoesNotAuthorizeASecondGatt() {
        Harness h = new Harness(); h.ready(); h.boundary.throwing = "close"; h.connection.cancel(); h.loop.run();
        assertEquals(GattTransport.State.CLOSED, h.connection.state()); assertEquals(1, h.link.closes);
        assertTrue(h.connection.closed().toCompletableFuture().isCompletedExceptionally());
        assertThrows(IllegalStateException.class, () -> h.transport.connect(ADDRESS, ID));
        h.connection.cancel(); h.transport.close(); h.loop.run(); assertTrue(h.loop.stopped); assertEquals(1, h.link.closes);
    }
    @Test public void consumerCancellationAndExceptionsCannotLeaveGattOpen() {
        Harness h = new Harness(); h.eventHook = () -> h.connection.cancel(); h.handshake(); h.link.finishWrites(); h.link.send(status(0)); h.closed();
        Harness failed = new Harness(); failed.eventHook = () -> { throw new IllegalStateException("consumer"); };
        failed.handshake(); failed.link.finishWrites(); failed.link.send(status(0)); failed.closed();
    }
    @Test public void nativeFailureDuringCommandPumpingClosesToo() {
        Harness h = new Harness(); h.ready(); h.boundary.throwing = "control-with-response";
        CompletionStage<Integer> result = h.transport.requestStatus(h.connection); h.loop.run(); h.closed(); assertTrue(result.toCompletableFuture().isCompletedExceptionally());
    }
    @Test public void queuedCommandsAreRevokedImmediatelyAndQueuesAreBounded() {
        Harness h = new Harness(); h.ready(); CompletionStage<Integer> pending = h.transport.requestStatus(h.connection); h.connection.cancel(); h.loop.run();
        assertTrue(pending.toCompletableFuture().isCompletedExceptionally()); h.closed(); assertEquals(1, h.link.sent.size());
        h.ready(); List<CompletionStage<Integer>> commands = new ArrayList<>();
        for (int i = 0; i <= GattTransport.MAX_COMMANDS; i++) commands.add(h.transport.requestStatus(h.connection));
        assertTrue(commands.get(GattTransport.MAX_COMMANDS).toCompletableFuture().isCompletedExceptionally()); h.connection.cancel(); h.loop.run(); h.closed();
        h.start(); for (int i = 0; i <= GattTransport.MAX_CALLBACKS; i++) h.link.callback.events(new byte[7]);
        assertTrue(h.loop.queue.size() <= GattTransport.MAX_CALLBACKS + 1); h.loop.run(); h.closed();
    }
    @Test public void commandsUseOneTransportAndWritesDoNotWaitForProtocolResponses() {
        Harness h = new Harness(); h.ready(); int time = h.await(h.transport.setTime(h.connection, n(0), 0)); int statusId = h.await(h.transport.requestStatus(h.connection));
        h.link.finishWrites(); Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.CONTROL); List<Integer> types = new ArrayList<>();
        for (Sent sent : h.link.sent) { Wire.Decoded message = assembler.accept(sent.bytes, 0); if (message != null) types.add(message.message.type); }
        assertEquals(Arrays.asList(1, 2, 1), types); assertEquals(1, h.boundary.links.size());
        h.link.send(status(statusId)); h.link.send(Codec.message(0x81, "requestId", time, "bootId", ID, "utcMs", n(0), "uptimeMs", n(10), "uncertaintyMs", 0));
        assertEquals(GattTransport.State.READY, h.connection.state()); assertEquals(3, h.events.size());
    }
    @Test public void manualCommitAckAcceptedAndRevokeUseTheSameGattWithoutStorage() {
        Harness h = new Harness(); h.ready(); String lease = h.await(h.transport.acquireJournal(h.connection)); int request = h.await(h.transport.fetch(h.connection, lease, n(0), 1));
        h.link.finishWrites(); Codec.Message begin = Codec.message(0x82, "requestId", request, "batchId", ID, "afterSequence", n(0), "throughSequence", n(3), "count", 1);
        Codec.Entry entry = Codec.entry(3, "fromSequence", n(1), "toSequence", n(3), "reason", 1);
        h.link.send(begin); h.link.send(Codec.message(0x83, "batchId", ID, "entry", entry)); h.link.send(sample(1));
        h.link.send(Codec.message(0x84, "batchId", ID, "digest", Codec.batchDigest(begin, Collections.singletonList(entry))));
        ProtocolSession.Batch batch = h.events.get(1).batch; String commit = h.await(h.transport.beginCommit(h.connection, lease, batch.token));
        assertEquals(2, h.link.sent.size()); int ack = h.await(h.transport.commitSucceeded(h.connection, lease, commit));
        h.link.send(Codec.message(0x87, "requestId", ack, "batchId", ID));
        CompletionStage<Integer> premature = h.transport.fetch(h.connection, lease, n(3), 1); h.loop.run(); assertTrue(premature.toCompletableFuture().isCompletedExceptionally());
        h.link.finishWrites(); assertEquals(ProtocolSession.Kind.ACK_ACCEPTED, h.events.get(2).kind);
        h.await(h.transport.fetch(h.connection, lease, n(3), 1)); h.await(h.transport.revokeJournal(h.connection, lease)); h.closed();
        assertTrue(h.transport.commitSucceeded(h.connection, lease, commit).toCompletableFuture().isCompletedExceptionally());
        assertEquals(1, h.boundary.links.size()); assertEquals(1, h.live.size());
    }
    @Test public void protocolFailureAndMalformedEventsClosePhysicalGatt() {
        for (byte[] bad : new byte[][]{null, new byte[6], new byte[21], new byte[20]}) {
            Harness h = new Harness(); h.ready(); h.link.callback.events(bad); h.loop.run(); h.closed();
        }
    }
    @Test public void disposeIsIdempotentAndDoesNotAllowAnotherSession() {
        Harness h = new Harness(); h.ready(); h.transport.close(); h.transport.close(); h.loop.run(); h.closed(); assertTrue(h.loop.stopped);
        h.link.callback.connection(0, GattBoundary.CONNECTED); assertTrue(h.loop.queue.isEmpty());
        assertThrows(IllegalStateException.class, () -> h.transport.connect(ADDRESS, ID));
        Harness idle = new Harness(); idle.transport.close(); idle.loop.run(); assertTrue(idle.loop.stopped);
    }
    @Test public void callbackRacingLoopShutdownDoesNotEscapeOntoBluetoothThread() {
        Harness h = new Harness(); h.ready();
        h.loop.beforeEnqueue = () -> { h.transport.close(); h.loop.run(); };
        h.link.callback.events(Wire.fragment(sample(1), 1, Wire.Direction.EVENTS).get(0));
        h.closed(); assertTrue(h.loop.queue.isEmpty());
    }
    @Test public void commandRacingLoopShutdownRejectsItsFuture() {
        Harness h = new Harness(); h.ready();
        h.loop.beforeEnqueue = () -> { h.transport.close(); h.loop.run(); };
        CompletionStage<Integer> result = h.transport.requestStatus(h.connection);
        assertTrue(result.toCompletableFuture().isCompletedExceptionally()); h.closed();
    }
}
