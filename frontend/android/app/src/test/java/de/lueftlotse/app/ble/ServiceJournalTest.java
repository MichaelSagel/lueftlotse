package de.lueftlotse.app.ble;

import de.lueftlotse.ble.*;
import java.math.BigInteger;
import java.util.*;
import java.util.concurrent.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real protocol core behind a fake serial transport; no Android, GATT or persistence. */
public class ServiceJournalTest {
    static final String ID = "00112233-4455-4677-8899-aabbccddeeff", OWNER = "webview-1";
    static final class Fixture implements ServiceJournal.Port {
        long now; int eventId; boolean transportClosed, earlyFetch;
        final ProtocolSession core = new ProtocolSession(() -> now);
        final String generation = core.open(Codec.encodeInfo(new Codec.Info(1, ID, 31)));
        final Wire.Assembler control = new Wire.Assembler(Wire.Direction.CONTROL);
        final List<Map<String, Object>> events = new ArrayList<>();
        ServiceJournal bridge;
        ServiceJournal.Token token;
        ProtocolSession.Batch batch;
        CompletableFuture<String> heldAcquire;
        Fixture() {
            Wire.Decoded handshake = write(); send(status(handshake.messageId)); core.pollEvent();
            bridge = new ServiceJournal(UUID.randomUUID().toString(), generation, this, Runnable::run, () -> now);
        }
        Codec.Message status(int request) { return Codec.message(0x80, "requestId", request, "bootId", ID, "oldest", BigInteger.ONE,
            "latest", UInt64.MAX, "overwrittenThrough", BigInteger.ZERO, "timeValid", 1, "firstUndated", BigInteger.ZERO, "storageState", 0); }
        void acquireClient() {
            Map<?, ?> value = (Map<?, ?>) bridge.acquire(OWNER, events::add).toCompletableFuture().join().get("token");
            token = new ServiceJournal.Token((String)value.get("runId"), (String)value.get("generation"), (String)value.get("clientId"), (String)value.get("leaseId"));
        }
        Wire.Decoded write() {
            Wire.Decoded decoded = null;
            while (decoded == null) {
                ProtocolSession.Write write = core.takeWrite(generation); assertNotNull(write);
                decoded = control.accept(write.frame(), now); core.writeCompleted(generation, write.token, true);
            }
            drain(); return decoded;
        }
        void send(Codec.Message message) {
            for (byte[] frame : Wire.fragment(message, eventId++, Wire.Direction.EVENTS)) core.receive(generation, frame);
            drain();
        }
        void drain() {
            if (bridge == null) return;
            ProtocolSession.Event event;
            while ((event = core.pollEvent()) != null) { if (event.batch != null) batch = event.batch; bridge.event(event); }
        }
        void packet(int request, BigInteger after) {
            Codec.Message begin = Codec.message(0x82, "requestId", request, "batchId", ID, "afterSequence", after, "throughSequence", after.add(BigInteger.ONE), "count", 1);
            Codec.Entry entry = Codec.entry(1, "sequence", after.add(BigInteger.ONE), "measurementId", ID, "bootId", ID, "segmentId", ID,
                "uptimeMs", UInt64.MAX, "utcMs", BigInteger.valueOf(-1), "ppm", 2500);
            send(begin); send(Codec.message(0x83, "batchId", ID, "entry", entry));
            send(Codec.message(0x84, "batchId", ID, "digest", Codec.batchDigest(begin, Collections.singletonList(entry))));
        }
        CompletableFuture<Map<String, Object>> fetch(BigInteger after) {
            return bridge.fetch(OWNER, token, UUID.randomUUID().toString(), after.toString(), 100).toCompletableFuture();
        }
        void batch() {
            acquireClient(); CompletableFuture<?> pending = fetch(BigInteger.ZERO); int request = write().messageId;
            assertFalse(pending.isDone()); packet(request, BigInteger.ZERO); pending.join();
        }
        Codec.Message ack() { return Codec.message(4, "batchId", ID, "throughSequence", batch.begin.big("throughSequence"), "count", 1, "digest", batch.digest()); }
        String prepare() { return (String) bridge.beginCommit(OWNER, token, batch.token, ack()).toCompletableFuture().join().get("commitToken"); }
        CompletableFuture<Map<String, Object>> commit(String commit) { return bridge.committed(OWNER, token, batch.token, commit, true, ack()).toCompletableFuture(); }
        public CompletionStage<String> acquire() {
            String id = core.acquireJournal(generation);
            return heldAcquire == null ? CompletableFuture.completedFuture(id) : heldAcquire;
        }
        public CompletionStage<Integer> status(String lease) { return CompletableFuture.completedFuture(core.journalStatus(generation, lease)); }
        public CompletionStage<Integer> fetch(String lease, BigInteger after, int limit) {
            int id = core.fetch(generation, lease, after, limit);
            if (earlyFetch) { write(); packet(id, after); }
            return CompletableFuture.completedFuture(id);
        }
        public CompletionStage<String> beginCommit(String lease, String batch) { return CompletableFuture.completedFuture(core.beginCommit(generation, lease, batch)); }
        public CompletionStage<Integer> commit(String lease, String token) { return CompletableFuture.completedFuture(core.commitSucceeded(generation, lease, token)); }
        public CompletionStage<Boolean> revoke(String lease) { return CompletableFuture.completedFuture(core.revokeJournal(generation, lease)); }
        public void close() { transportClosed = true; core.disconnect(generation, "closed"); bridge.closed("closed"); }
    }
    @Test public void explicitCommitThenAckThenMatchingAcceptedGatesNextFetch() {
        Fixture f = new Fixture(); f.batch(); String commit = f.prepare();
        assertNull(f.core.takeWrite(f.generation));
        assertThrows(IllegalStateException.class, () -> f.fetch(BigInteger.ONE));
        CompletableFuture<?> completed = f.commit(commit);
        assertThrows(IllegalStateException.class, () -> f.commit(commit));
        Wire.Decoded ack = f.write(); assertEquals(4, ack.message.type); assertFalse(completed.isDone());
        assertThrows(IllegalStateException.class, () -> f.fetch(BigInteger.ONE));
        f.send(Codec.message(0x87, "requestId", ack.messageId + 1, "batchId", ID)); assertFalse(completed.isDone());
        f.send(Codec.message(0x87, "requestId", ack.messageId, "batchId", ID)); completed.join();
        assertFalse(f.fetch(BigInteger.ONE).isDone()); assertEquals(3, f.write().message.type);
    }
    @Test public void beginEntryEndAreBoundedAndUint64IsNeverANumber() {
        Fixture f = new Fixture(); f.acquireClient(); BigInteger after = UInt64.MAX.subtract(BigInteger.ONE);
        CompletableFuture<?> result = f.fetch(after); f.packet(f.write().messageId, after); result.join();
        assertEquals(3, f.events.size()); assertEquals("BEGIN", f.events.get(0).get("kind")); assertEquals("ENTRY", f.events.get(1).get("kind")); assertEquals("END", f.events.get(2).get("kind"));
        Map<?, ?> begin = (Map<?, ?>)f.events.get(0).get("message"); assertEquals(UInt64.MAX.toString(), begin.get("throughSequence"));
        Map<?, ?> entry = (Map<?, ?>)((Map<?, ?>)f.events.get(1).get("message")).get("entry");
        assertEquals(UInt64.MAX.toString(), entry.get("sequence")); assertEquals(UInt64.MAX.toString(), entry.get("uptimeMs")); assertEquals("-1", entry.get("utcMs"));
        assertNull(f.core.takeWrite(f.generation));
    }
    @Test public void correlationHandlesResponseBeforeTheCommandFutureCompletes() {
        Fixture f = new Fixture(); f.acquireClient(); f.earlyFetch = true;
        assertEquals("batch", f.fetch(BigInteger.ZERO).join().get("kind")); assertEquals(3, f.events.size());
    }
    @Test public void wrongAckParametersAndMissingCommitConfirmationCannotEnqueueAck() {
        Fixture f = new Fixture(); f.batch();
        Codec.Message wrong = Codec.message(4, "batchId", ID, "throughSequence", BigInteger.TEN, "count", 1, "digest", f.batch.digest());
        assertThrows(IllegalStateException.class, () -> f.bridge.beginCommit(OWNER, f.token, f.batch.token, wrong));
        String commit = f.prepare();
        assertThrows(IllegalStateException.class, () -> f.bridge.committed(OWNER, f.token, f.batch.token, commit, false, f.ack()));
        assertThrows(IllegalStateException.class, () -> f.bridge.committed(OWNER, f.token, f.batch.token, commit, true, wrong));
        assertNull(f.core.takeWrite(f.generation)); f.commit(commit); assertEquals(4, f.write().message.type);
    }
    @Test public void webViewRevocationDuringCommitClosesWithoutAckAndRejectsLateConfirmation() {
        Fixture f = new Fixture(); f.batch(); String commit = f.prepare();
        f.bridge.revokeOwner(OWNER); assertTrue(f.transportClosed); assertNull(f.core.takeWrite(f.generation));
        assertThrows(IllegalStateException.class, () -> f.commit(commit));
        assertEquals("REVOKED", f.events.get(3).get("kind"));
    }
    @Test public void idleRevocationKeepsLiveConnectionAndOldClientCannotRevokeNewLease() {
        Fixture f = new Fixture(); f.acquireClient(); ServiceJournal.Token old = f.token;
        f.bridge.revoke(OWNER, old); assertFalse(f.transportClosed); f.acquireClient();
        f.bridge.revoke(OWNER, old); assertThrows(IllegalStateException.class, () -> f.bridge.status(OWNER, old));
        assertThrows(IllegalStateException.class, () -> f.bridge.status("another-webview", f.token));
        assertThrows(IllegalStateException.class, () -> f.bridge.acquire(OWNER, f.events::add));
        assertFalse(f.bridge.status(OWNER, f.token).toCompletableFuture().isDone());
    }
    @Test public void heartbeatLossAndRevocationDuringFetchNeverCreateAck() {
        Fixture f = new Fixture(); f.acquireClient(); CompletableFuture<?> fetch = f.fetch(BigInteger.ZERO);
        f.now = ServiceJournal.CLIENT_TIMEOUT_MS; f.bridge.tick();
        assertTrue(f.transportClosed); assertTrue(fetch.isCompletedExceptionally()); assertNull(f.core.takeWrite(f.generation));
        f.bridge.revokeOwner(OWNER); // Idempotent, including late callbacks.
    }
    @Test public void lostAckAcceptedClosesAndDoesNotRetryOrAdvance() {
        Fixture f = new Fixture(); f.batch(); CompletableFuture<?> committed = f.commit(f.prepare()); f.write();
        f.now = 5000; f.core.tick(f.generation); f.drain();
        assertTrue(committed.isCompletedExceptionally()); assertThrows(IllegalStateException.class, () -> f.fetch(BigInteger.ONE));
        assertNull(f.core.takeWrite(f.generation));
    }
    @Test public void staleConnectionEventsCannotSatisfyANewClient() {
        Fixture old = new Fixture(); old.acquireClient(); old.core.fetch(old.generation, old.token.leaseId, BigInteger.ZERO, 1); old.write();
        old.bridge = null; old.packet(1, BigInteger.ZERO); ProtocolSession.Event late = old.core.pollEvent(); assertNotNull(late);
        Fixture fresh = new Fixture(); fresh.acquireClient(); CompletableFuture<?> pending = fresh.fetch(BigInteger.ZERO);
        fresh.bridge.event(late); assertFalse(pending.isDone()); assertTrue(fresh.events.isEmpty());
    }
    @Test public void fetchLimitsAndDecimalRangeAreCheckedBeforeWriting() {
        Fixture f = new Fixture(); f.acquireClient();
        for (String invalid : new String[]{"-1", "01", "18446744073709551616", "1.0"})
            assertThrows(RuntimeException.class, () -> f.bridge.fetch(OWNER, f.token, ID, invalid, 100));
        assertThrows(IllegalStateException.class, () -> f.bridge.fetch(OWNER, f.token, ID, "0", 101)); assertNull(f.core.takeWrite(f.generation));
    }
    @Test public void pendingAcquisitionIsRevokedAndItsLateResultCannotReviveTheClient() {
        Fixture f = new Fixture(); f.heldAcquire = new CompletableFuture<>();
        CompletableFuture<?> acquisition = f.bridge.acquire(OWNER, f.events::add).toCompletableFuture();
        f.bridge.revokeOwner(OWNER); assertTrue(f.transportClosed); assertTrue(acquisition.isCompletedExceptionally());
        f.heldAcquire.complete(UUID.randomUUID().toString()); assertTrue(f.events.isEmpty());
        assertThrows(IllegalStateException.class, () -> f.bridge.acquire(OWNER, f.events::add));
    }
    @Test public void idleHeartbeatExpiryReleasesOnlyItsLeaseAndOldCommitCannotCrossGenerations() {
        Fixture old = new Fixture(); old.batch(); String commit = old.prepare();
        Fixture fresh = new Fixture(); fresh.acquireClient();
        assertThrows(IllegalStateException.class, () -> fresh.bridge.committed(OWNER, old.token, old.batch.token, commit, true, old.ack()));
        fresh.now = 6000; fresh.bridge.tick(); assertFalse(fresh.transportClosed); fresh.acquireClient();
        assertEquals(ProtocolSession.State.READY, fresh.core.state()); assertNull(fresh.core.takeWrite(fresh.generation));
    }
}
