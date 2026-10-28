package de.lueftlotse.ble;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.LongSupplier;
import static de.lueftlotse.ble.ProtocolException.require;

/**
 * Pull-driven protocol engine, without GATT, Android, timers, callbacks or persistence.
 * Public methods are synchronized. The owner pumps writes/events and calls tick regularly.
 * A write completion is NOT a command response. Both must arrive before command completion.
 */
public final class ProtocolSession {
    public static final int MAX_EXCHANGES = 4, MAX_EVENTS = 32;
    public enum State { CLOSED, HANDSHAKE, READY }
    public enum Kind { READY, RESPONSE, BATCH, ACK_ACCEPTED, CANCELLED, NOTICE, CLOSED }
    private enum Phase { IDLE, FETCHING, RECEIVING, AVAILABLE, COMMITTING, ACKING, CANCELLING }

    public static final class Write {
        public final String generation, token;
        public final int messageId, fragmentIndex;
        private final byte[] frame;
        private Write(String generation, int id, int index, byte[] frame) {
            this.generation = generation; token = UUID.randomUUID().toString(); messageId = id; fragmentIndex = index; this.frame = frame.clone();
        }
        public byte[] frame() { return frame.clone(); }
    }
    public static final class Batch {
        public final String generation, lease, token, deviceId;
        public final Codec.Message begin;
        public final List<Codec.Entry> entries;
        private final byte[] digest;
        private Batch(String generation, String lease, String deviceId, Codec.Message begin, List<Codec.Entry> entries, byte[] digest) {
            this.generation = generation; this.lease = lease; this.deviceId = deviceId; token = UUID.randomUUID().toString();
            this.begin = begin; this.entries = Collections.unmodifiableList(new ArrayList<>(entries)); this.digest = digest.clone();
        }
        public byte[] digest() { return digest.clone(); }
        /** JSON-safe data for a future bridge; uint64 and UTC are decimal strings. */
        public Map<String, Object> toBridge() {
            Map<String, Object> result = new LinkedHashMap<>(); result.put("generation", generation); result.put("lease", lease);
            result.put("token", token); result.put("deviceId", deviceId); result.put("begin", begin.toBridge()); result.put("digest", Codec.hex(digest));
            List<Map<String, Object>> values = new ArrayList<>(); for (Codec.Entry entry : entries) values.add(entry.toBridge());
            result.put("entries", Collections.unmodifiableList(values)); return Collections.unmodifiableMap(result);
        }
    }
    public static final class Event {
        public final Kind kind;
        public final String generation, detail;
        public final int requestId;
        public final Codec.Message message;
        public final Batch batch;
        private Event(Kind kind, String generation, int requestId, Codec.Message message, Batch batch, String detail) {
            this.kind = kind; this.generation = generation; this.requestId = requestId; this.message = message; this.batch = batch; this.detail = detail;
        }
    }
    private static final class Exchange {
        final int id;
        final Codec.Message command;
        final List<byte[]> frames;
        final long queuedAt;
        int next;
        long writtenAt, startedAt;
        boolean written, started;
        Codec.Message response;
        Exchange(int id, Codec.Message command, long now) {
            this.id = id; this.command = command; queuedAt = now; frames = Wire.fragment(command, id, Wire.Direction.CONTROL);
        }
    }

    private final LongSupplier clock;
    private State state = State.CLOSED;
    private String generation, lease, commitToken;
    private Codec.Info info;
    private Codec.Message status, latestSample;
    private BigInteger lastCounter, lastUptime;
    private Wire.Assembler assembler;
    private int nextId;
    private long lastNow = -1, writeStarted;
    private final Deque<Exchange> writes = new ArrayDeque<>();
    private final Map<Integer, Exchange> responses = new LinkedHashMap<>();
    private final Deque<Event> events = new ArrayDeque<>();
    private Write inFlight;
    private Phase phase = Phase.IDLE;
    private BigInteger fetchAfter;
    private int fetchLimit;
    private boolean fetchWritten;
    private Codec.Message batchBegin;
    private final List<Codec.Entry> batchEntries = new ArrayList<>();
    private byte[] batchEnd;
    private long batchStarted, batchEnded;
    private Batch batch;

    public ProtocolSession(LongSupplier monotonicMilliseconds) { clock = Objects.requireNonNull(monotonicMilliseconds); }
    public synchronized State state() { return state; }
    public synchronized Codec.Info info() { return info; }
    public synchronized Codec.Message status() { return status; }
    public synchronized int pendingResponses() { return responses.size(); }
    public synchronized int queuedMessages() { return writes.size(); }
    public synchronized Event pollEvent() { return events.pollFirst(); }
    /** One overwriteable preview slot. Reading it never creates journal entries or ACKs. */
    public synchronized Codec.Message pollLiveSample(String generation) {
        if (!current(generation)) return null; Codec.Message result = latestSample; latestSample = null; return result;
    }

    /** Call ONLY for a new physical connection, after Info read and successful CCCD subscription. */
    public synchronized String open(byte[] infoBytes) {
        require(state == State.CLOSED, "Close the old physical connection before opening another");
        Codec.Info parsed = Codec.decodeInfo(infoBytes); long now = clock.getAsLong(); require(now >= 0, "Invalid clock");
        // Opaque epoch also distinguishes a replacement engine instance from the old one.
        generation = UUID.randomUUID().toString();
        info = parsed; status = null; latestSample = null; lastCounter = null; lastUptime = null; nextId = 0;
        assembler = new Wire.Assembler(Wire.Direction.EVENTS); lastNow = now;
        events.clear(); writes.clear(); responses.clear(); inFlight = null; lease = null; clearBatch();
        state = State.HANDSHAKE; enqueue(Codec.message(1), now); return generation;
    }
    public synchronized void disconnect(String generation, String reason) { if (current(generation)) close(reason); }
    public synchronized void subscriptionLost(String generation) { if (current(generation)) close("Events subscription lost"); }

    /** At most one write-with-response is outstanding; all fragments of a message stay consecutive. */
    public synchronized Write takeWrite(String generation) {
        if (!current(generation)) return null; tick(generation); if (!current(generation) || inFlight != null || writes.isEmpty()) return null;
        Exchange x = writes.peekFirst();
        if (!x.started) { x.started = true; x.startedAt = lastNow; }
        inFlight = new Write(generation, x.id, x.next, x.frames.get(x.next)); writeStarted = lastNow; return inFlight;
    }
    /** Recheck immediately before a deferred transport write on the owner's serialized executor. */
    public synchronized boolean isWriteCurrent(String generation, String token) {
        if (!current(generation)) return false; tick(generation);
        return current(generation) && inFlight != null && inFlight.token.equals(token);
    }
    public synchronized boolean writeCompleted(String generation, String token, boolean success) {
        if (!current(generation)) return false; tick(generation);
        if (!current(generation) || inFlight == null || !inFlight.token.equals(token)) return false;
        if (!success) { close("Control write failed or outcome uncertain"); return true; }
        Exchange x = writes.peekFirst(); inFlight = null; x.next++;
        if (x.next == x.frames.size()) {
            writes.removeFirst(); x.written = true; x.writtenAt = lastNow;
            complete(x); closeIfIdsExhausted();
        }
        return true;
    }
    /** Old generation callbacks are ignored before reading bytes or the clock. */
    public synchronized void receive(String generation, byte[] frame) {
        if (!current(generation)) return; tick(generation); if (!current(generation)) return;
        try {
            Wire.Decoded decoded = assembler.accept(frame, lastNow);
            if (decoded != null) handle(decoded.message);
            if (assembler.exhausted() && assembler.bufferedBytes() == 0) close("Events message IDs exhausted");
        } catch (ProtocolException e) { close(e.getMessage()); }
    }
    public synchronized void tick(String generation) {
        if (!current(generation)) return;
        try {
            long now = clock.getAsLong(); require(now >= 0 && now >= lastNow, "Monotonic clock moved backwards"); lastNow = now;
            assembler.tick(now);
            require(inFlight == null || now - writeStarted < 5000, "Control write timeout");
            for (Exchange x : responses.values()) {
                require(x.written || now - x.queuedAt < 30000, "Control queue timeout");
                require(!x.started || x.written || now - x.startedAt < 5000, "Outgoing fragment sequence timeout");
                require(!x.written || x.response != null || now - x.writtenAt < 5000, "Command response timeout");
            }
            if (batchBegin != null && batchEnd == null) require(now - batchStarted < 30000, "Batch receive timeout");
            if (batchEnd != null) require(now - batchEnded < 30000, "Batch commit/ACK snapshot expired");
        } catch (ProtocolException e) { close(e.getMessage()); }
    }

    public synchronized int requestStatus(String generation) {
        ready(generation); require(lease == null, "Journal owns Control commands"); return enqueue(Codec.message(1), lastNow);
    }
    public synchronized int setTime(String generation, BigInteger utcMs, long uncertaintyMs) {
        ready(generation); require(lease == null && info.supports(4), "Time operation unavailable");
        return enqueue(Codec.message(2, "bootId", status.text("bootId"), "utcMs", utcMs, "uncertaintyMs", uncertaintyMs), lastNow);
    }
    /** The future WebView owner acquires/revokes this lease with its lifecycle. No automatic FETCH. */
    public synchronized String acquireJournal(String generation) {
        ready(generation); require(info.supports(0x0a) && lease == null && responses.isEmpty(), "Journal unavailable/busy");
        lease = UUID.randomUUID().toString(); return lease;
    }
    public synchronized int journalStatus(String generation, String lease) {
        journal(generation, lease); require(phase == Phase.IDLE && responses.isEmpty(), "Journal busy"); return enqueue(Codec.message(1), lastNow);
    }
    public synchronized int fetch(String generation, String lease, BigInteger afterSequence, int limit) {
        journal(generation, lease); require(phase == Phase.IDLE && responses.isEmpty(), "Previous batch/ACK is not finished");
        Codec.Message command = Codec.message(3, "afterSequence", afterSequence, "limit", limit);
        int id = enqueue(command, lastNow); fetchAfter = afterSequence; fetchLimit = limit; fetchWritten = false; phase = Phase.FETCHING; return id;
    }
    /** Called just before starting the external atomic IndexedDB transaction. Token is single-use. */
    public synchronized String beginCommit(String generation, String lease, String batchToken) {
        journal(generation, lease); require(phase == Phase.AVAILABLE && batch != null && batch.token.equals(batchToken), "Stale batch token");
        phase = Phase.COMMITTING; commitToken = UUID.randomUUID().toString(); return commitToken;
    }
    /** Trust boundary: the bridge may call this ONLY after IndexedDB transaction.oncomplete. */
    public synchronized int commitSucceeded(String generation, String lease, String token) {
        journal(generation, lease); require(phase == Phase.COMMITTING && commitToken.equals(token), "Stale commit token");
        int id = enqueue(Codec.message(4, "batchId", batch.begin.text("batchId"), "throughSequence", batch.begin.big("throughSequence"),
                "count", batch.begin.number("count"), "digest", batch.digest), lastNow);
        commitToken = null; phase = Phase.ACKING; return id;
    }
    public synchronized void commitFailed(String generation, String lease, String token) {
        journal(generation, lease); require(phase == Phase.COMMITTING && commitToken.equals(token), "Stale commit token"); close("Atomic commit failed; no ACK");
    }
    /** A completed, uncommitted snapshot can be cancelled; in-flight/uncertain work is revoked by closing. */
    public synchronized int cancelBatch(String generation, String lease, String batchToken) {
        journal(generation, lease); require(phase == Phase.AVAILABLE && batch.token.equals(batchToken), "Stale batch token");
        int id = enqueue(Codec.message(5, "batchId", batch.begin.text("batchId")), lastNow); phase = Phase.CANCELLING; return id;
    }
    public synchronized boolean revokeJournal(String generation, String lease) {
        if (!current(generation) || this.lease == null || !this.lease.equals(lease)) return false;
        if (phase != Phase.IDLE || !responses.isEmpty()) close("Journal client revoked during exchange; no uncommitted ACK");
        else { this.lease = null; clearBatch(); }
        return true;
    }

    private boolean current(String generation) { return state != State.CLOSED && this.generation.equals(generation); }
    private void ready(String generation) {
        require(current(generation), "Stale connection generation"); tick(generation); require(state == State.READY, "Handshake incomplete/connection closed");
    }
    private void journal(String generation, String lease) { ready(generation); require(this.lease != null && this.lease.equals(lease), "Stale journal lease"); }
    private int enqueue(Codec.Message command, long now) {
        require(responses.size() < MAX_EXCHANGES, "Control queue full");
        if (nextId > 65534) { close("Control message IDs exhausted"); throw new ProtocolException("Control message IDs exhausted"); }
        Exchange x = new Exchange(nextId++, command, now); responses.put(x.id, x); writes.addLast(x); return x.id;
    }
    private void handle(Codec.Message m) {
        if (m.type == 0x8a) {
            if (state != State.READY || !info.supportsLiveSample() || !status.text("bootId").equals(m.text("bootId"))) return;
            if (lastCounter != null && (m.big("sampleCounter").compareTo(lastCounter) <= 0 || m.big("uptimeMs").compareTo(lastUptime) < 0)) return;
            lastCounter = m.big("sampleCounter"); lastUptime = m.big("uptimeMs"); latestSample = m; return;
        }
        if (m.type == 0x83 || m.type == 0x84) { batchPart(m); return; }
        if (m.type == 0x86 || m.type == 0x88) {
            if (state == State.READY && info.supports(m.type == 0x86 ? 1 : 2)) emit(Kind.NOTICE, -1, m, null); return;
        }
        require(m.has("requestId"), "Unexpected Events message"); int request = (int) m.number("requestId");
        if (request == 65535) {
            if (m.type == 0x80 && state == State.READY) { checkBoot(m); status = m; emit(Kind.NOTICE, request, m, null); }
            else if (m.type == 0xff && state == State.READY) { if (m.number("code") == 7) latestSample = null; emit(Kind.NOTICE, request, m, null); }
            return;
        }
        Exchange x = responses.get(request);
        // A stray/old response cannot satisfy a new exchange, even if its batchId happens to match.
        if (x == null || !x.started) return;
        require(x.response == null, "Duplicate command response");
        require(matches(x.command.type, m.type), "Wrong correlated response type");
        if (m.type == 0x80 || m.type == 0x81 || m.type == 0x85) checkBoot(m);
        if (m.type == 0x87 || m.type == 0x89) require(x.command.text("batchId").equals(m.text("batchId")), "Wrong correlated batchId");
        if (x.command.type == 3 && m.type == 0x80) require(m.big("latest").equals(fetchAfter), "FETCH STATUS does not mark end of journal");
        if (m.type == 0x82) {
            require(phase == Phase.FETCHING && m.big("afterSequence").equals(fetchAfter) && m.number("count") <= fetchLimit, "Unexpected batch boundaries");
            batchBegin = m; batchStarted = lastNow; phase = Phase.RECEIVING;
        }
        x.response = m; complete(x);
    }
    private static boolean matches(int command, int response) {
        if (response == 0xff) return true;
        switch (command) {
            case 1: return response == 0x80;
            case 2: return response == 0x81;
            case 3: return response == 0x82 || response == 0x80 || response == 0x85;
            case 4: return response == 0x87;
            case 5: return response == 0x89;
            default: return false;
        }
    }
    private void checkBoot(Codec.Message message) {
        if (status != null) require(status.text("bootId").equals(message.text("bootId")), "bootId changed in this connection");
    }
    private void complete(Exchange x) {
        if (!x.written || x.response == null || state == State.CLOSED) return;
        responses.remove(x.id); Codec.Message m = x.response;
        if (state == State.HANDSHAKE) {
            if (m.type != 0x80) { close("STATUS handshake rejected"); return; }
            status = m; state = State.READY; emit(Kind.READY, x.id, m, null); return;
        }
        if (m.type == 0x80) status = m;
        if (x.command.type == 3) {
            if (m.type == 0x82) { fetchWritten = true; publishBatch(); }
            else { clearBatch(); emit(Kind.RESPONSE, x.id, m, null); }
        } else if (x.command.type == 4 || x.command.type == 5) {
            if (m.type == 0xff) { emit(Kind.RESPONSE, x.id, m, null); close("Batch completion rejected"); }
            else { clearBatch(); emit(x.command.type == 4 ? Kind.ACK_ACCEPTED : Kind.CANCELLED, x.id, m, null); }
        } else emit(Kind.RESPONSE, x.id, m, null);
        closeIfIdsExhausted();
    }
    private void batchPart(Codec.Message m) {
        require(phase == Phase.RECEIVING && batchBegin != null && batchEnd == null, "Unsolicited/out of order batch data");
        require(batchBegin.text("batchId").equals(m.text("batchId")), "Wrong batchId");
        if (m.type == 0x83) {
            require(batchEntries.size() < batchBegin.number("count") && batchEntries.size() < 100, "Too many batch entries"); batchEntries.add(m.entry());
        } else {
            byte[] actual = Codec.batchDigest(batchBegin, batchEntries);
            require(MessageDigest.isEqual(actual, m.bytes("digest")), "Batch digest mismatch");
            batchEnd = actual; batchEnded = lastNow; publishBatch();
        }
    }
    private void publishBatch() {
        if (fetchWritten && batchEnd != null && phase == Phase.RECEIVING) {
            batch = new Batch(generation, lease, info.deviceId, batchBegin, batchEntries, batchEnd);
            phase = Phase.AVAILABLE; emit(Kind.BATCH, (int) batchBegin.number("requestId"), null, batch);
        }
    }
    private void clearBatch() {
        phase = Phase.IDLE; batch = null; batchBegin = null; batchEnd = null; batchEntries.clear();
        commitToken = null; fetchAfter = null; fetchWritten = false;
    }
    private void emit(Kind kind, int id, Codec.Message message, Batch batch) {
        if (events.size() == MAX_EVENTS) { close("Consumer event queue full"); return; }
        events.addLast(new Event(kind, generation, id, message, batch, null));
    }
    private void closeIfIdsExhausted() { if (state != State.CLOSED && nextId > 65534 && responses.isEmpty()) close("Control message IDs exhausted"); }
    private void close(String reason) {
        if (state == State.CLOSED) return; state = State.CLOSED; writes.clear(); responses.clear(); inFlight = null;
        latestSample = null; lease = null; clearBatch();
        if (events.size() == MAX_EVENTS) events.clear();
        events.addLast(new Event(Kind.CLOSED, generation, -1, null, null, reason));
    }
}
