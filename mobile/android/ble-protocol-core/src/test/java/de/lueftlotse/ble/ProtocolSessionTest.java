package de.lueftlotse.ble;

import org.junit.Test;
import java.util.*;
import static de.lueftlotse.ble.Fixtures.*;
import static org.junit.Assert.*;

public class ProtocolSessionTest {
    @Test public void handshakeNeedsCorrelatedStatusAndSuccessfulControlWrite() {
        Link f = new Link(); f.open(1, 31);
        assertThrows(ProtocolException.class, () -> f.core.requestStatus(f.generation));
        assertThrows(ProtocolException.class, () -> f.core.open(info(1, 31)));
        f.send(status(65535)); f.send(status(44)); f.send(live(1, 0)); assertNull(f.core.pollLiveSample(f.generation));
        ProtocolSession.Write write = f.core.takeWrite(f.generation); f.send(status(write.messageId));
        assertEquals(ProtocolSession.State.HANDSHAKE, f.core.state()); assertNull(f.core.pollEvent());
        f.send(live(2, 1)); f.finish(write); assertEquals(ProtocolSession.State.READY, f.core.state());
        assertEquals(ProtocolSession.Kind.READY, f.core.pollEvent().kind); assertNull(f.core.pollLiveSample(f.generation));
        f.send(live(3, 2)); assertEquals(n(3), f.core.pollLiveSample(f.generation).big("sampleCounter"));
    }
    @Test public void failedWriteCannotCompleteHandshakeEvenAfterEarlyStatus() {
        Link f = new Link(); f.open(1, 31); ProtocolSession.Write write = f.core.takeWrite(f.generation); f.send(status(write.messageId));
        f.core.writeCompleted(f.generation, write.token, false); f.assertClosed();
    }
    @Test public void unsupportedInfoDoesNotQueueCommands() {
        Link f = new Link(); byte[] bytes = info(1, 31); bytes[1] = 2;
        assertThrows(ProtocolException.class, () -> f.core.open(bytes)); assertEquals(0, f.core.queuedMessages()); assertEquals(ProtocolSession.State.CLOSED, f.core.state());
    }
    @Test public void liveRequiresMinorAndCapabilityButDoesNotRequireJournalOrTime() {
        for (int[] pair : new int[][]{{0, 0}, {0, 15}, {1, 0}, {1, 15}, {1, 16}, {1, 31}}) {
            Link f = new Link(); f.open(pair[0], pair[1]); f.handshake(); f.send(live(1, 0));
            assertEquals(pair[0] == 1 && (pair[1] & 16) != 0, f.core.pollLiveSample(f.generation) != null);
            if ((pair[1] & 10) != 10) assertThrows(ProtocolException.class, () -> f.core.acquireJournal(f.generation));
            if ((pair[1] & 4) == 0) assertThrows(ProtocolException.class, () -> f.core.setTime(f.generation, n(0), 0));
        }
    }
    @Test public void liveChecksBootIncreasingCounterNondecreasingUptimeAndLatestSlot() {
        Link f = new Link(); f.ready(); f.send(live(2, 10)); f.send(live(3, 10));
        assertEquals(n(3), f.core.pollLiveSample(f.generation).big("sampleCounter")); assertNull(f.core.pollEvent());
        f.send(live(3, 11)); f.send(live(2, 12)); f.send(live(4, 9)); f.send(live(OTHER, n(5), n(20)));
        assertNull(f.core.pollLiveSample(f.generation));
        f.send(live(ID, UInt64.MAX, UInt64.MAX)); assertEquals(UInt64.MAX, f.core.pollLiveSample(f.generation).big("sampleCounter"));
        assertNull(f.core.takeWrite(f.generation)); assertEquals(0, f.core.pendingResponses());
    }
    @Test public void sensorErrorInvalidatesPendingPreviewAndUnsubscriptionCloses() {
        Link f = new Link(); f.ready(); f.send(live(1, 0)); f.send(Codec.message(0xff, "requestId", 65535, "code", 7));
        assertNull(f.core.pollLiveSample(f.generation)); assertEquals(ProtocolSession.Kind.NOTICE, f.core.pollEvent().kind);
        f.core.subscriptionLost(f.generation); f.assertClosed();
    }
    @Test public void queueIsIndependentOfResponsesAndDoesNotInterleaveFragments() {
        Link f = new Link(); f.ready(); int time = f.core.setTime(f.generation, n(-1), 0), status = f.core.requestStatus(f.generation);
        ProtocolSession.Write first = f.core.takeWrite(f.generation); assertEquals(time, first.messageId); assertNull(f.core.takeWrite(f.generation));
        assertFalse(f.core.writeCompleted(f.generation, "wrong-token", true)); f.finish(first);
        assertEquals(2, f.core.pendingResponses()); assertEquals(status, f.writeMessage().messageId); assertEquals(0, f.core.queuedMessages());
        f.send(status(status)); assertEquals(status, f.core.pollEvent().requestId); assertEquals(1, f.core.pendingResponses());
        f.send(Codec.message(0x81, "requestId", time, "bootId", ID, "utcMs", n(-1), "uptimeMs", n(10), "uncertaintyMs", 0));
        assertEquals(time, f.core.pollEvent().requestId); assertEquals(0, f.core.pendingResponses());
    }
    @Test public void queueAndEventOutputAreBounded() {
        Link f = new Link(); f.ready(); for (int i = 0; i < ProtocolSession.MAX_EXCHANGES; i++) f.core.requestStatus(f.generation);
        assertThrows(ProtocolException.class, () -> f.core.requestStatus(f.generation)); assertEquals(4, f.core.queuedMessages());
        for (int i = 0; i <= ProtocolSession.MAX_EVENTS; i++) f.send(status(65535)); f.assertClosed();
        assertEquals(ProtocolSession.Kind.CLOSED, f.core.pollEvent().kind); assertNull(f.core.pollEvent());
    }
    @Test public void responseTimeoutStartsAfterLastWriteAndPendingWriteHasOwnTimeout() {
        Link f = new Link(); f.open(1, 31); f.writeMessage(); f.now = 4999; f.core.tick(f.generation); assertEquals(ProtocolSession.State.HANDSHAKE, f.core.state());
        f.now = 5000; f.core.tick(f.generation); f.assertClosed();
        f.open(1, 31); ProtocolSession.Write write = f.core.takeWrite(f.generation); f.now += 5000;
        assertFalse(f.core.writeCompleted(f.generation, write.token, true)); f.assertClosed();
    }
    @Test public void queuedWritesAndStoppedFragmentsExpireWithoutNewInput() {
        Link f = new Link(); f.open(1, 31); f.now = 30000; f.core.tick(f.generation); f.assertClosed();
        f.open(1, 31); f.writeMessage(); f.core.receive(f.generation, Wire.fragment(status(0), 0, Wire.Direction.EVENTS).get(0));
        f.now += 5000; f.core.tick(f.generation); f.assertClosed();
    }
    @Test public void outgoingFragmentSequenceDeadlineIsNotExtendedByIndividualWriteCompletions() {
        Link f = new Link(); f.ready(); f.core.setTime(f.generation, n(0), 0);
        ProtocolSession.Write first = f.core.takeWrite(f.generation); f.now = 3000; f.core.writeCompleted(f.generation, first.token, true);
        ProtocolSession.Write second = f.core.takeWrite(f.generation); assertNotNull(second); f.now = 5000;
        assertFalse(f.core.writeCompleted(f.generation, second.token, true)); f.assertClosed();
    }
    @Test public void backwardsClockAndCorruptEventsCloseConnection() {
        Link f = new Link(); f.now = 10; f.ready(); f.now = 9; f.core.tick(f.generation); f.assertClosed();
        f.open(1, 31); f.handshake(); byte[] corrupt = Wire.fragment(Codec.message(0xff, "requestId", 65535, "code", 7), 1, Wire.Direction.EVENTS).get(0);
        corrupt[corrupt.length - 1] ^= 1; f.core.receive(f.generation, corrupt); f.assertClosed();
    }
    @Test public void oldGenerationCallbacksWritesAndLeasesCannotTouchReconnection() {
        Link f = new Link(); f.ready(); String old = f.generation, lease = f.core.acquireJournal(old);
        f.core.fetch(old, lease, n(0), 100); ProtocolSession.Write write = f.core.takeWrite(old); f.core.disconnect(old, "radio");
        f.open(1, 31); ProtocolSession.Write fresh = f.core.takeWrite(f.generation);
        assertFalse(f.core.writeCompleted(old, write.token, true)); assertFalse(f.core.writeCompleted(f.generation, write.token, true));
        for (byte[] frame : Wire.fragment(status(fresh.messageId), 1, Wire.Direction.EVENTS)) f.core.receive(old, frame);
        f.core.subscriptionLost(old); f.core.disconnect(old, "late disconnect"); assertFalse(f.core.revokeJournal(old, lease));
        assertThrows(ProtocolException.class, () -> f.core.fetch(old, lease, n(0), 1));
        assertEquals(ProtocolSession.State.HANDSHAKE, f.core.state()); f.finish(fresh); f.send(status(fresh.messageId));
        assertEquals(ProtocolSession.State.READY, f.core.state()); f.core.pollEvent(); f.send(live(1, 0)); assertNotNull(f.core.pollLiveSample(f.generation));
    }
    @Test public void statusBootChangeAndWrongCorrelatedResponseClose() {
        Link f = new Link(); f.ready(); f.send(status(65535, OTHER, 3)); f.assertClosed();
        f.ready(); int id = f.core.requestStatus(f.generation); f.writeMessage(); f.send(accepted(id)); f.assertClosed();
    }
    @Test public void commitTokenThenAckThenMatchingAcceptedIsTheOnlyWayToNextFetch() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        assertNull(f.core.takeWrite(f.generation)); assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, lease, batch.token));
        String commit = f.core.beginCommit(f.generation, lease, batch.token); assertNull(f.core.takeWrite(f.generation));
        assertThrows(ProtocolException.class, () -> f.core.fetch(f.generation, lease, n(3), 100));
        int ack = f.core.commitSucceeded(f.generation, lease, commit);
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, lease, commit));
        Wire.Decoded written = f.writeMessage(); assertEquals(4, written.message.type); assertEquals(ack, written.messageId);
        assertEquals(ID, written.message.text("batchId")); assertEquals(n(3), written.message.big("throughSequence"));
        assertArrayEquals(batch.digest(), written.message.bytes("digest"));
        f.send(accepted(ack + 1)); assertEquals(1, f.core.pendingResponses());
        assertThrows(ProtocolException.class, () -> f.core.fetch(f.generation, lease, n(3), 100));
        f.send(accepted(ack)); assertEquals(ProtocolSession.Kind.ACK_ACCEPTED, f.core.pollEvent().kind);
        assertEquals(0, f.core.pendingResponses()); assertTrue(f.core.fetch(f.generation, lease, n(3), 100) > ack);
    }
    @Test public void earlyAcceptedStillWaitsForEveryAckFragmentWriteResponse() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        int ack = f.core.commitSucceeded(f.generation, lease, f.core.beginCommit(f.generation, lease, batch.token));
        ProtocolSession.Write first = f.core.takeWrite(f.generation); f.send(accepted(ack)); assertNull(f.core.pollEvent());
        assertThrows(ProtocolException.class, () -> f.core.fetch(f.generation, lease, n(3), 100));
        f.finish(first); assertEquals(ProtocolSession.Kind.ACK_ACCEPTED, f.core.pollEvent().kind); f.core.fetch(f.generation, lease, n(3), 100);
    }
    @Test public void packetMayArriveBeforeFetchWriteResponseButCannotBeCommittedYet() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); int request = f.core.fetch(f.generation, lease, n(0), 1);
        ProtocolSession.Write write = f.core.takeWrite(f.generation); f.packet(request); assertNull(f.core.pollEvent());
        f.finish(write); assertEquals(ProtocolSession.Kind.BATCH, f.core.pollEvent().kind);
    }
    @Test public void failedCommitAndClientRevocationNeverCreateUncommittedAck() {
        for (boolean failed : new boolean[]{true, false}) {
            Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
            String commit = f.core.beginCommit(f.generation, lease, batch.token);
            if (failed) f.core.commitFailed(f.generation, lease, commit); else assertTrue(f.core.revokeJournal(f.generation, lease));
            f.assertClosed(); assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, lease, commit));
        }
    }
    @Test public void commitTokensCannotBeUsedByOtherLeasesBatchesOrGenerations() {
        Link f = new Link(); f.ready(); String oldGeneration = f.generation, oldLease = f.core.acquireJournal(f.generation);
        ProtocolSession.Batch oldBatch = f.batch(oldLease); String oldCommit = f.core.beginCommit(f.generation, oldLease, oldBatch.token);
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, "different-lease", oldCommit));
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, oldLease, "different-token"));
        f.core.revokeJournal(f.generation, oldLease); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        assertThrows(ProtocolException.class, () -> f.core.beginCommit(f.generation, lease, oldBatch.token));
        String commit = f.core.beginCommit(f.generation, lease, batch.token);
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(oldGeneration, oldLease, oldCommit));
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, lease, oldCommit));
        assertNull(f.core.takeWrite(f.generation)); f.core.commitSucceeded(f.generation, lease, commit); assertEquals(4, f.writeMessage().message.type);
    }
    @Test public void lateCommitAfterRevokeCannotSendOnNewConnection() {
        Link f = new Link(); f.ready(); String generation = f.generation, lease = f.core.acquireJournal(generation); ProtocolSession.Batch batch = f.batch(lease);
        String commit = f.core.beginCommit(generation, lease, batch.token); f.core.revokeJournal(generation, lease); f.ready();
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(generation, lease, commit)); assertNull(f.core.takeWrite(f.generation));
    }
    @Test public void revokeDropsQueuedOrPartiallyWrittenCommittedAck() {
        for (boolean partial : new boolean[]{false, true}) {
            Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
            f.core.commitSucceeded(f.generation, lease, f.core.beginCommit(f.generation, lease, batch.token));
            ProtocolSession.Write write = partial ? f.core.takeWrite(f.generation) : null;
            if (write != null) assertTrue(f.core.isWriteCurrent(f.generation, write.token));
            f.core.revokeJournal(f.generation, lease); f.assertClosed();
            if (write != null) {
                assertFalse(f.core.isWriteCurrent(f.generation, write.token));
                assertFalse(f.core.writeCompleted(f.generation, write.token, true));
            }
        }
    }
    @Test public void idleLeaseReleaseKeepsSessionButBusyReleaseCloses() {
        Link f = new Link(); f.ready(); String first = f.core.acquireJournal(f.generation); assertTrue(f.core.revokeJournal(f.generation, first));
        String second = f.core.acquireJournal(f.generation); assertFalse(f.core.revokeJournal(f.generation, first));
        assertThrows(ProtocolException.class, () -> f.core.fetch(f.generation, first, n(0), 100));
        assertThrows(ProtocolException.class, () -> f.core.requestStatus(f.generation));
        f.core.fetch(f.generation, second, n(0), 100); f.core.revokeJournal(f.generation, second); f.assertClosed();
    }
    @Test public void wrongAckBatchIdClosesAndDoesNotPermitNextFetch() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        int ack = f.core.commitSucceeded(f.generation, lease, f.core.beginCommit(f.generation, lease, batch.token)); f.writeMessage();
        f.send(Codec.message(0x87, "requestId", ack, "batchId", OTHER)); f.assertClosed();
    }
    @Test public void cancelWaitsForMatchingCancelledAndDoesNotSendAck() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        int cancel = f.core.cancelBatch(f.generation, lease, batch.token); assertEquals(5, f.writeMessage().message.type);
        assertThrows(ProtocolException.class, () -> f.core.fetch(f.generation, lease, n(0), 100));
        f.send(Codec.message(0x89, "requestId", cancel, "batchId", ID)); assertEquals(ProtocolSession.Kind.CANCELLED, f.core.pollEvent().kind);
        assertThrows(ProtocolException.class, () -> f.core.beginCommit(f.generation, lease, batch.token)); f.core.fetch(f.generation, lease, n(0), 100);
    }
    @Test public void batchReceiveAndCommitDeadlinesAreBoundedDespiteLiveTraffic() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation);
        int id = f.core.fetch(f.generation, lease, n(0), 100); f.writeMessage(); f.send(begin(id)); f.now = 29999; f.send(live(1, 0));
        f.now = 30000; f.core.tick(f.generation); f.assertClosed();
        f.ready(); String nextLease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(nextLease);
        String commit = f.core.beginCommit(f.generation, nextLease, batch.token); f.now += 30000;
        assertThrows(ProtocolException.class, () -> f.core.commitSucceeded(f.generation, nextLease, commit)); f.assertClosed();
    }
    @Test public void batchRejectsWrongIdDigestEntryCountAndCoverage() {
        for (int failure = 0; failure < 5; failure++) {
            Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); int id = f.core.fetch(f.generation, lease, n(0), 1); f.writeMessage(); f.send(begin(id));
            if (failure == 0) f.send(Codec.message(0x83, "batchId", OTHER, "entry", gap(1, 3)));
            else {
                if (failure != 1) f.send(Codec.message(0x83, "batchId", ID, "entry", gap(failure == 2 ? 2 : 1, 3)));
                if (failure == 3) f.send(Codec.message(0x83, "batchId", ID, "entry", gap(1, 3)));
                else f.send(Codec.message(0x84, "batchId", ID, "digest", new byte[32]));
            }
            f.assertClosed(); assertNull(f.core.pollLiveSample(f.generation));
        }
    }
    @Test public void fetchHandlesTimePendingEndStatusAndExplicitErrorWithoutAutoRetry() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation);
        int id = f.core.fetch(f.generation, lease, n(0), 100); f.writeMessage();
        f.send(Codec.message(0x85, "requestId", id, "bootId", ID, "firstUndated", n(1), "latest", n(3)));
        assertEquals(0x85, f.core.pollEvent().message.type); assertNull(f.core.takeWrite(f.generation));
        id = f.core.fetch(f.generation, lease, n(3), 100); f.writeMessage(); f.send(status(id)); assertEquals(0x80, f.core.pollEvent().message.type);
        id = f.core.fetch(f.generation, lease, n(3), 100); f.writeMessage(); f.send(Codec.message(0xff, "requestId", id, "code", 3));
        assertEquals(3, f.core.pollEvent().message.number("code")); assertNull(f.core.takeWrite(f.generation)); assertTrue(f.core.revokeJournal(f.generation, lease));
    }
    @Test public void ackResponseTimeoutClosesWithoutRetryEvenThoughCommitSucceeded() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        f.core.commitSucceeded(f.generation, lease, f.core.beginCommit(f.generation, lease, batch.token)); f.writeMessage(); f.now += 5000;
        f.core.tick(f.generation); f.assertClosed();
    }
    @Test public void generationsAreDistinctAcrossReplacementEngineInstances() {
        Link old = new Link(), replacement = new Link(); old.ready(); replacement.open(1, 31);
        assertNotEquals(old.generation, replacement.generation);
        for (byte[] frame : Wire.fragment(status(0), 0, Wire.Direction.EVENTS)) replacement.core.receive(old.generation, frame);
        assertEquals(ProtocolSession.State.HANDSHAKE, replacement.core.state());
    }
    @Test public void fetchCannotSilentlySkipRecordsThroughStatus() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation);
        int id = f.core.fetch(f.generation, lease, n(0), 100); f.writeMessage(); f.send(status(id)); f.assertClosed();
    }
    @Test public void oldAckAcceptedCannotCompleteNewAckWithSameRequestIdAndBatchId() {
        Link f = new Link(); f.ready(); String oldGeneration = f.generation, oldLease = f.core.acquireJournal(f.generation);
        ProtocolSession.Batch oldBatch = f.batch(oldLease);
        int oldAck = f.core.commitSucceeded(f.generation, oldLease, f.core.beginCommit(f.generation, oldLease, oldBatch.token)); f.writeMessage();
        f.core.disconnect(f.generation, "radio"); f.ready(); String lease = f.core.acquireJournal(f.generation); ProtocolSession.Batch batch = f.batch(lease);
        int ack = f.core.commitSucceeded(f.generation, lease, f.core.beginCommit(f.generation, lease, batch.token)); f.writeMessage(); assertEquals(oldAck, ack);
        for (byte[] frame : Wire.fragment(accepted(oldAck), 40, Wire.Direction.EVENTS)) f.core.receive(oldGeneration, frame);
        assertEquals(1, f.core.pendingResponses()); assertNull(f.core.pollEvent());
        assertThrows(ProtocolException.class, () -> f.core.fetch(f.generation, lease, n(3), 100));
        f.send(accepted(ack)); assertEquals(ProtocolSession.Kind.ACK_ACCEPTED, f.core.pollEvent().kind);
    }
    @Test public void maximumBatchInterleavesOnlyWholeLiveMessagesAndRemainsImmutable() {
        Link f = new Link(); f.ready(); String lease = f.core.acquireJournal(f.generation);
        int id = f.core.fetch(f.generation, lease, n(0), 100); f.writeMessage();
        Codec.Message begin = Codec.message(0x82, "requestId", id, "batchId", ID, "afterSequence", n(0), "throughSequence", n(100), "count", 100);
        f.send(begin); List<Codec.Entry> entries = new ArrayList<>();
        for (int i = 1; i <= 100; i++) {
            Codec.Entry entry = gap(i, i); entries.add(entry); f.send(Codec.message(0x83, "batchId", ID, "entry", entry)); f.send(live(i, i));
        }
        f.send(Codec.message(0x84, "batchId", ID, "digest", Codec.batchDigest(begin, entries)));
        ProtocolSession.Batch batch = f.core.pollEvent().batch; assertEquals(100, batch.entries.size()); assertEquals(n(100), f.core.pollLiveSample(f.generation).big("sampleCounter"));
        assertThrows(UnsupportedOperationException.class, () -> batch.entries.clear()); assertNotNull(batch.toBridge());
        batch.digest()[0] ^= 1; assertArrayEquals(Codec.batchDigest(begin, entries), batch.digest()); assertNull(f.core.takeWrite(f.generation));
    }
    @Test public void controlIdsExhaustWithoutWrapAndOnlyNewConnectionResetsThem() {
        Link f = new Link(); f.ready();
        for (int id = 1; id <= 65534; id++) {
            assertEquals(id, f.core.requestStatus(f.generation)); assertEquals(id, f.writeMessage().messageId); f.send(status(id));
            assertEquals(ProtocolSession.Kind.RESPONSE, f.core.pollEvent().kind);
        }
        f.assertClosed(); f.open(1, 31); assertEquals(0, f.writeMessage().messageId);
    }
    @Test public void eventsIdsExhaustWithoutWrapAndPreviewMemoryStaysBounded() {
        Link f = new Link(); f.ready();
        for (int id = 1; id <= 65535; id++) f.send(live(id, id));
        f.assertClosed(); assertEquals(ProtocolSession.Kind.CLOSED, f.core.pollEvent().kind); assertNull(f.core.pollEvent());
    }
}
