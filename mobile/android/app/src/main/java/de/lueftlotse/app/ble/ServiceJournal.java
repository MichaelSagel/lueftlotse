package de.lueftlotse.app.ble;

import de.lueftlotse.ble.*;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.*;

/** One volatile WebView lease. All calls and continuations run on the service command queue. */
public final class ServiceJournal {
    public static final long CLIENT_TIMEOUT_MS = 6000;
    public interface Port {
        CompletionStage<String> acquire();
        CompletionStage<Integer> status(String lease);
        CompletionStage<Integer> fetch(String lease, BigInteger after, int limit);
        CompletionStage<String> beginCommit(String lease, String batch);
        CompletionStage<Integer> commit(String lease, String token);
        CompletionStage<Boolean> revoke(String lease);
        void close();
    }
    public static final class Token {
        public final String runId, generation, clientId, leaseId;
        public Token(String run, String generation, String client, String lease) {
            runId = Objects.requireNonNull(run); this.generation = Objects.requireNonNull(generation);
            clientId = Objects.requireNonNull(client); leaseId = Objects.requireNonNull(lease);
        }
        public Map<String, Object> toBridge() { return map("runId", runId, "generation", generation, "clientId", clientId, "leaseId", leaseId); }
        boolean same(Token other) { return other != null && toBridge().equals(other.toBridge()); }
    }
    private enum Phase { ACQUIRING, IDLE, STATUS, FETCH, AVAILABLE, PREPARING, COMMIT, ACK, REVOKED }
    private static final class Pending {
        final Phase phase;
        final CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
        int request = -1;
        ProtocolSession.Event early;
        Pending(Phase phase) { this.phase = phase; }
    }
    private static final class Lease {
        final String owner, client = UUID.randomUUID().toString();
        final Consumer<Map<String, Object>> sink;
        final CompletableFuture<Map<String, Object>> acquired = new CompletableFuture<>();
        Token token;
        Phase phase = Phase.ACQUIRING;
        Pending pending;
        ProtocolSession.Batch batch;
        String commit;
        String operation;
        CompletableFuture<Map<String, Object>> preparing;
        long heartbeat;
        Lease(String owner, Consumer<Map<String, Object>> sink, long now) { this.owner = owner; this.sink = sink; heartbeat = now; }
    }
    private final String runId, generation;
    private final Port port;
    private final Consumer<Runnable> dispatch;
    private final LongSupplier clock;
    private Lease active;
    private boolean closed;
    public ServiceJournal(String runId, String generation, Port port, Consumer<Runnable> dispatch, LongSupplier clock) {
        this.runId = runId; this.generation = generation; this.port = port; this.dispatch = dispatch; this.clock = clock;
    }
    public static Map<String, Object> map(Object... pairs) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        return Collections.unmodifiableMap(result);
    }
    private static void require(boolean valid, String reason) { if (!valid) throw new IllegalStateException(reason); }
    public CompletionStage<Map<String, Object>> acquire(String owner, Consumer<Map<String, Object>> sink) {
        require(!closed && active == null, "Journal unavailable/busy");
        Lease lease = new Lease(owner, sink, clock.getAsLong()); active = lease;
        try {
            port.acquire().whenComplete((id, error) -> dispatch.accept(() -> {
                if (!current(lease)) return; // Revocation during acquisition closes the connection.
                if (error != null) { active = null; lease.acquired.completeExceptionally(error); return; }
                lease.token = new Token(runId, generation, lease.client, id); lease.phase = Phase.IDLE;
                lease.acquired.complete(map("token", lease.token.toBridge()));
            }));
        } catch (RuntimeException error) { active = null; lease.acquired.completeExceptionally(error); }
        return lease.acquired;
    }
    private boolean current(Lease lease) { return !closed && active == lease && lease.phase != Phase.REVOKED; }
    private Lease owned(String owner, Token token) {
        tick(); Lease lease = active;
        require(lease != null && current(lease) && lease.owner.equals(owner) && lease.token != null && lease.token.same(token), "Stale journal client/lease");
        return lease;
    }
    public void heartbeat(String owner, Token token) { owned(owner, token).heartbeat = clock.getAsLong(); }
    public CompletionStage<Map<String, Object>> status(String owner, Token token) {
        Lease lease = owned(owner, token); require(lease.phase == Phase.IDLE, "Journal busy");
        return exchange(lease, Phase.STATUS, () -> port.status(token.leaseId));
    }
    public CompletionStage<Map<String, Object>> fetch(String owner, Token token, String operation, String after, int limit) {
        Lease lease = owned(owner, token); require(lease.phase == Phase.IDLE, "Previous batch/ACK is not finished");
        BigInteger cursor = UInt64.fromDecimal(after); require(limit >= 1 && limit <= 100, "Invalid FETCH limit");
        lease.operation = Codec.uuid(operation);
        return exchange(lease, Phase.FETCH, () -> port.fetch(token.leaseId, cursor, limit));
    }
    private CompletionStage<Map<String, Object>> exchange(Lease lease, Phase phase, Supplier<CompletionStage<Integer>> issue) {
        Pending pending = new Pending(phase); lease.phase = phase; lease.pending = pending;
        try {
            issue.get().whenComplete((id, error) -> dispatch.accept(() -> {
                if (!current(lease) || lease.pending != pending) return;
                if (error != null) { fail(lease, error); return; }
                pending.request = id;
                if (pending.early != null) { ProtocolSession.Event event = pending.early; pending.early = null; event(event); }
            }));
        } catch (RuntimeException error) { fail(lease, error); }
        return pending.result;
    }
    private void checkBatch(Lease lease, String ticket, Codec.Message ack) {
        require(lease.batch != null && lease.batch.token.equals(ticket), "Stale batch token");
        ProtocolSession.Batch batch = lease.batch;
        require(ack.type == 4 && ack.text("batchId").equals(batch.begin.text("batchId")) &&
            ack.big("throughSequence").equals(batch.begin.big("throughSequence")) && ack.number("count") == batch.begin.number("count") &&
            MessageDigest.isEqual(ack.bytes("digest"), batch.digest()), "ACK parameters do not match batch");
    }
    public CompletionStage<Map<String, Object>> beginCommit(String owner, Token token, String ticket, Codec.Message ack) {
        Lease lease = owned(owner, token); require(lease.phase == Phase.AVAILABLE, "Batch not available"); checkBatch(lease, ticket, ack);
        lease.phase = Phase.PREPARING;
        CompletableFuture<Map<String, Object>> result = new CompletableFuture<>(); lease.preparing = result;
        try {
            port.beginCommit(token.leaseId, ticket).whenComplete((commit, error) -> dispatch.accept(() -> {
                if (!current(lease)) return;
                if (error != null) { fail(lease, error); return; }
                lease.phase = Phase.COMMIT; lease.commit = commit; lease.preparing = null; result.complete(map("commitToken", commit));
            }));
        } catch (RuntimeException error) { fail(lease, error); }
        return result;
    }
    /** The only ACK entry point. TypeScript calls only AFTER its atomic transaction completed. */
    public CompletionStage<Map<String, Object>> committed(String owner, Token token, String ticket, String commit, boolean committed, Codec.Message ack) {
        Lease lease = owned(owner, token);
        require(committed && lease.phase == Phase.COMMIT && lease.commit.equals(commit), "Unconfirmed/stale commit token");
        checkBatch(lease, ticket, ack); lease.commit = null; // Consume before enqueue; no retries of an uncertain ACK.
        return exchange(lease, Phase.ACK, () -> port.commit(token.leaseId, commit));
    }
    public void event(ProtocolSession.Event event) {
        if (closed || !generation.equals(event.generation)) return;
        if (event.kind == ProtocolSession.Kind.CLOSED) { closed(event.detail); return; }
        Lease lease = active;
        if (lease == null || !current(lease) || lease.pending == null || event.kind == ProtocolSession.Kind.NOTICE || event.kind == ProtocolSession.Kind.READY) return;
        Pending pending = lease.pending;
        if (pending.request < 0) {
            if (pending.early != null) { fail(lease, new IllegalStateException("Unexpected extra response")); return; }
            pending.early = event; return;
        }
        if (pending.request != event.requestId) return;
        try {
            Map<String, Object> response;
            if (pending.phase == Phase.FETCH && event.kind == ProtocolSession.Kind.BATCH) {
                ProtocolSession.Batch batch = event.batch;
                require(batch != null && batch.generation.equals(generation) && batch.lease.equals(lease.token.leaseId) && batch.entries.size() <= 100, "Wrong batch owner/bounds");
                lease.batch = batch; lease.phase = Phase.AVAILABLE;
                send(lease, "BEGIN", batch.begin.toBridge());
                for (Codec.Entry entry : batch.entries) send(lease, "ENTRY", Codec.message(0x83, "batchId", batch.begin.text("batchId"), "entry", entry).toBridge());
                send(lease, "END", Codec.message(0x84, "batchId", batch.begin.text("batchId"), "digest", batch.digest()).toBridge());
                response = map("kind", "batch", "ticketId", batch.token);
            } else if (pending.phase == Phase.ACK) {
                require(event.kind == ProtocolSession.Kind.ACK_ACCEPTED && event.message.type == 0x87 &&
                    event.message.text("batchId").equals(lease.batch.begin.text("batchId")), "Expected matching ACK_ACCEPTED");
                response = map("kind", "ack-accepted", "message", event.message.toBridge()); lease.batch = null; lease.phase = Phase.IDLE;
            } else {
                require(event.kind == ProtocolSession.Kind.RESPONSE && event.message != null, "Unexpected journal response");
                int type = event.message.type;
                require(type == 0x80 || type == 0xff || (pending.phase == Phase.FETCH && type == 0x85), "Wrong journal response");
                response = map("kind", type == 0xff ? "error" : type == 0x85 ? "time-pending" : "status", "message", event.message.toBridge());
                lease.phase = Phase.IDLE;
            }
            if (!current(lease)) return;
            lease.pending = null; pending.result.complete(response);
        } catch (RuntimeException error) { fail(lease, error); }
    }
    private void send(Lease lease, String kind, Map<String, Object> message) {
        require(current(lease), "Journal client revoked");
        lease.sink.accept(map("kind", kind, "token", lease.token.toBridge(), "operationId", lease.operation, "ticketId", lease.batch.token, "message", message));
    }
    public void revoke(String owner, Token token) {
        if (active != null && active.owner.equals(owner) && active.token != null && active.token.same(token)) revokeLease(active, "Journal revoked");
    }
    public void revokeOwner(String owner) { if (active != null && active.owner.equals(owner)) revokeLease(active, "WebView unavailable"); }
    public void tick() {
        Lease lease = active;
        if (lease != null && current(lease)) {
            long elapsed = clock.getAsLong() - lease.heartbeat;
            if (elapsed < 0 || elapsed >= CLIENT_TIMEOUT_MS) revokeLease(lease, "WebView heartbeat expired");
        }
    }
    private void fail(Lease lease, Throwable error) { revokeLease(lease, error.getMessage()); }
    private void reject(Lease lease, String reason) {
        IllegalStateException error = new IllegalStateException(reason);
        lease.acquired.completeExceptionally(error);
        if (lease.pending != null) lease.pending.result.completeExceptionally(error);
        if (lease.preparing != null) lease.preparing.completeExceptionally(error);
        lease.pending = null; lease.preparing = null; lease.batch = null; lease.commit = null;
        if (lease.token != null) try { lease.sink.accept(map("kind", "REVOKED", "token", lease.token.toBridge(), "reason", reason)); } catch (RuntimeException ignored) { }
    }
    private void revokeLease(Lease lease, String reason) {
        if (!current(lease)) return;
        boolean safe = lease.phase == Phase.IDLE;
        lease.phase = Phase.REVOKED; reject(lease, reason);
        if (!safe) { port.close(); return; } // Includes acquisition, receiving, commit and uncertain ACK.
        try {
            port.revoke(lease.token.leaseId).whenComplete((ok, error) -> dispatch.accept(() -> {
                if (active != lease) return;
                if (error != null || !Boolean.TRUE.equals(ok)) port.close(); else active = null;
            }));
        } catch (RuntimeException error) { port.close(); }
    }
    public void closed(String reason) {
        if (closed) return; closed = true;
        if (active != null) { active.phase = Phase.REVOKED; reject(active, reason); active = null; }
    }
}
