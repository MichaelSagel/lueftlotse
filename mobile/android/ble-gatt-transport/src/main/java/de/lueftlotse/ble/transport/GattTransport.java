package de.lueftlotse.ble.transport;

import de.lueftlotse.ble.Codec;
import de.lueftlotse.ble.ProtocolSession;
import java.math.BigInteger;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.*;
import java.util.function.Function;

/** Single GATT owner. The protocol core is private and is accessed only on the serial loop. */
public final class GattTransport implements AutoCloseable {
    public static final long CONNECT_TIMEOUT_MS = 10000, OPERATION_TIMEOUT_MS = 5000, TICK_MS = 100;
    public static final int MAX_CALLBACKS = 128, MAX_COMMANDS = 32;
    public enum State { CONNECTING, DISCOVERING, READING_INFO, SUBSCRIBING, HANDSHAKE, READY, CLOSED }
    public interface Listener {
        // Invoked on the loop. Must not block/wait on transport futures or perform storage here.
        void event(Connection connection, ProtocolSession.Event event);
        void live(Connection connection, Codec.Message sample);
        void closed(Connection connection, String reason);
    }
    public static final class Connection {
        public final String id = UUID.randomUUID().toString();
        private final GattTransport owner;
        private final String address, expectedDeviceId;
        private final AtomicBoolean cancelled = new AtomicBoolean();
        private final AtomicInteger callbacks = new AtomicInteger();
        private final CompletableFuture<Codec.Info> ready = new CompletableFuture<>();
        private final CompletableFuture<Void> closed = new CompletableFuture<>();
        private volatile State state = State.CONNECTING;
        private volatile boolean cleaned;
        private GattBoundary.Link link;
        private SerialLoop.Timer timer;
        private long deadline;
        private byte[] infoBytes;
        private Codec.Info info;
        private ProtocolSession core;
        private String generation;
        private ProtocolSession.Write write;
        private Connection(GattTransport owner, String address, String expectedDeviceId) {
            this.owner = owner; this.address = address; this.expectedDeviceId = expectedDeviceId;
        }
        public State state() { return state; }
        public CompletionStage<Codec.Info> ready() { return ready.thenApply(value -> value); }
        public CompletionStage<Void> closed() { return closed.thenApply(value -> value); }
        public void cancel() { owner.cancel(this, "Connection cancelled"); }
    }

    private final GattBoundary boundary;
    private final SerialLoop loop;
    private final Listener listener;
    private final AtomicReference<Connection> active = new AtomicReference<>();
    private final AtomicInteger commands = new AtomicInteger();
    private final AtomicBoolean disposed = new AtomicBoolean();

    public GattTransport(GattBoundary boundary, SerialLoop loop, Listener listener) {
        this.boundary = Objects.requireNonNull(boundary); this.loop = Objects.requireNonNull(loop); this.listener = Objects.requireNonNull(listener);
    }
    /** Reserves the sole slot immediately, even before the queued connect call begins. */
    public synchronized Connection connect(String address, String expectedDeviceId) {
        if (address == null || !address.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")) throw new IllegalArgumentException("Invalid BLE address");
        String expected = expectedDeviceId == null ? null : Codec.uuid(expectedDeviceId);
        Connection connection = new Connection(this, address, expected);
        if (disposed.get() || !active.compareAndSet(null, connection)) throw new IllegalStateException("Transport closed or connection already reserved");
        try { loop.execute(() -> start(connection)); }
        catch (RejectedExecutionException e) { active.compareAndSet(connection, null); throw e; }
        return connection;
    }
    private void start(Connection c) {
        onLoop();
        if (!usable(c)) { finish(c, "Connection cancelled before connect"); return; }
        try {
            phase(c, State.CONNECTING, CONNECT_TIMEOUT_MS);
            c.link = boundary.connect(c.address, callbacks(c));
            if (c.link == null) throw new IllegalStateException("connectGatt returned null");
            // cancel() can run while the synchronous connectGatt call is returning its handle.
            if (!usable(c)) { finish(c, "Connect completed after cancellation"); return; }
            checkDeadline(c); scheduleTick(c);
        } catch (RuntimeException e) { finish(c, reason(e)); }
    }
    private boolean usable(Connection c) { return active.get() == c && !c.cancelled.get() && !c.cleaned && !disposed.get(); }
    private void onLoop() { if (!loop.isOnLoop()) throw new IllegalStateException("Core/GATT accessed outside serial loop"); }
    private void phase(Connection c, State state, long timeout) {
        c.state = state; c.deadline = timeout == 0 ? Long.MAX_VALUE : loop.now() + timeout;
    }
    private void checkDeadline(Connection c) {
        if (loop.now() >= c.deadline) throw new IllegalStateException(c.state + " timeout");
    }
    private void scheduleTick(Connection c) {
        if (c.cleaned) return;
        c.timer = loop.schedule(() -> {
            if (!usable(c)) { finish(c, "Connection cancelled"); return; }
            try { checkDeadline(c); pump(c); }
            catch (RuntimeException e) { finish(c, reason(e)); }
            scheduleTick(c);
        }, TICK_MS);
    }
    private void post(Connection c, Runnable action) {
        if (c.cleaned) return;
        if (c.callbacks.incrementAndGet() > MAX_CALLBACKS) {
            c.callbacks.decrementAndGet(); cancel(c, "GATT callback queue overflow"); return;
        }
        Runnable queued = () -> {
            c.callbacks.decrementAndGet(); onLoop();
            if (!usable(c)) { finish(c, "Connection cancelled"); return; }
            try { checkDeadline(c); action.run(); if (usable(c)) pump(c); }
            catch (RuntimeException e) { finish(c, reason(e)); }
        };
        try { loop.execute(queued); }
        catch (RejectedExecutionException stopped) {
            c.callbacks.decrementAndGet();
            // Disposal can finish between the callback's initial check and Handler.post.
            if (!c.cleaned) throw stopped;
        }
    }
    private static byte[] snapshot(byte[] bytes, int max) { return bytes != null && bytes.length <= max ? bytes.clone() : null; }
    private void expect(Connection c, State expected, int status) {
        if (c.state != expected || status != GattBoundary.SUCCESS) throw new IllegalStateException("Unexpected/failed " + expected + " callback: " + status);
    }
    private static void accepted(boolean accepted, String operation) { if (!accepted) throw new IllegalStateException(operation + " was rejected"); }
    private GattBoundary.Callbacks callbacks(Connection c) {
        return new GattBoundary.Callbacks() {
            public void connection(int status, int newState) { post(c, () -> {
                if (status != GattBoundary.SUCCESS || newState == GattBoundary.DISCONNECTED) { finish(c, "GATT disconnected/status " + status); return; }
                expect(c, State.CONNECTING, status);
                if (newState != GattBoundary.CONNECTED) throw new IllegalStateException("Unexpected connection state " + newState);
                phase(c, State.DISCOVERING, OPERATION_TIMEOUT_MS); accepted(c.link.discover(), "Discovery");
            }); }
            public void discovered(int status) { post(c, () -> {
                expect(c, State.DISCOVERING, status); accepted(c.link.validateProfile(), "GATT profile validation");
                phase(c, State.READING_INFO, OPERATION_TIMEOUT_MS); accepted(c.link.readInfo(), "Info read");
            }); }
            public void info(int status, byte[] value) {
                byte[] copy = snapshot(value, 20);
                post(c, () -> {
                    expect(c, State.READING_INFO, status);
                    if (copy == null) throw new IllegalStateException("Missing/oversized Info");
                    c.info = Codec.decodeInfo(copy); c.infoBytes = copy;
                    if (c.expectedDeviceId != null && !c.expectedDeviceId.equals(c.info.deviceId)) throw new IllegalStateException("Info UUID mismatch");
                    accepted(c.link.enableLocalNotifications(), "Local Events subscription");
                    phase(c, State.SUBSCRIBING, OPERATION_TIMEOUT_MS); accepted(c.link.writeNotificationCccd(), "CCCD write");
                });
            }
            public void subscribed(int status) { post(c, () -> {
                expect(c, State.SUBSCRIBING, status); c.core = new ProtocolSession(() -> { onLoop(); return loop.now(); });
                c.generation = c.core.open(c.infoBytes); phase(c, State.HANDSHAKE, CONNECT_TIMEOUT_MS);
            }); }
            public void written(String token, int status) { post(c, () -> {
                if (c.write == null || !c.write.token.equals(token)) throw new IllegalStateException("Unexpected/stale Control write callback");
                ProtocolSession.Write write = c.write; c.write = null;
                c.core.writeCompleted(c.generation, write.token, status == GattBoundary.SUCCESS);
            }); }
            public void events(byte[] value) {
                byte[] copy = snapshot(value, 20);
                post(c, () -> {
                    // Firmware can notify between the local enable and the CCCD response. No handshake yet.
                    if (c.core == null) return;
                    c.core.receive(c.generation, copy);
                });
            }
            public void failure(String reason) { post(c, () -> finish(c, reason)); }
        };
    }
    private void pump(Connection c) {
        onLoop(); if (!usable(c) || c.core == null) return;
        c.core.tick(c.generation);
        ProtocolSession.Event event;
        while ((event = c.core.pollEvent()) != null) {
            if (event.kind == ProtocolSession.Kind.CLOSED) { finish(c, event.detail); return; }
            if (event.kind == ProtocolSession.Kind.READY) {
                phase(c, State.READY, 0); c.ready.complete(c.info);
            }
            if (!usable(c)) { finish(c, "Cancelled by consumer"); return; }
            listener.event(c, event);
        }
        if (!usable(c)) { finish(c, "Cancelled by consumer"); return; }
        Codec.Message sample = c.core.pollLiveSample(c.generation); if (sample != null) listener.live(c, sample);
        if (!usable(c)) { finish(c, "Cancelled by consumer"); return; }
        if (c.core.state() == ProtocolSession.State.CLOSED) { finish(c, "Protocol closed"); return; }
        if (c.write == null) {
            ProtocolSession.Write write = c.core.takeWrite(c.generation);
            if (write != null) {
                c.write = write;
                if (!usable(c) || !c.core.isWriteCurrent(c.generation, write.token)) { finish(c, "Write revoked"); return; }
                accepted(c.link.writeControl(write.frame(), write.token), "Control write-with-response");
            }
        }
    }
    private <T> CompletableFuture<T> command(Connection c, Function<ProtocolSession, T> action) {
        CompletableFuture<T> result = new CompletableFuture<>();
        if (c == null || c.owner != this || !usable(c)) { result.completeExceptionally(new IllegalStateException("Stale connection")); return result; }
        if (commands.incrementAndGet() > MAX_COMMANDS) {
            commands.decrementAndGet(); result.completeExceptionally(new IllegalStateException("Command queue full")); return result;
        }
        Runnable queued = () -> {
            commands.decrementAndGet(); onLoop();
            if (!usable(c) || c.core == null) { result.completeExceptionally(new IllegalStateException("Cancelled/not handshaken")); return; }
            T value;
            try { value = action.apply(c.core); }
            catch (RuntimeException e) {
                result.completeExceptionally(e);
                // Invalid caller arguments do not close a healthy connection; core CLOSED must close GATT.
                if (c.core.state() == ProtocolSession.State.CLOSED) finish(c, reason(e));
                return;
            }
            try { pump(c); result.complete(value); }
            catch (RuntimeException e) { finish(c, reason(e)); result.completeExceptionally(e); }
        };
        try { loop.execute(queued); }
        catch (RejectedExecutionException stopped) { commands.decrementAndGet(); result.completeExceptionally(stopped); }
        return result;
    }
    public CompletionStage<Integer> requestStatus(Connection c) { return command(c, core -> core.requestStatus(c.generation)); }
    public CompletionStage<Integer> setTime(Connection c, BigInteger utcMs, long uncertaintyMs) { return command(c, core -> core.setTime(c.generation, utcMs, uncertaintyMs)); }
    public CompletionStage<String> acquireJournal(Connection c) { return command(c, core -> core.acquireJournal(c.generation)); }
    public CompletionStage<Integer> journalStatus(Connection c, String lease) { return command(c, core -> core.journalStatus(c.generation, lease)); }
    public CompletionStage<Integer> fetch(Connection c, String lease, BigInteger cursor, int limit) { return command(c, core -> core.fetch(c.generation, lease, cursor, limit)); }
    public CompletionStage<String> beginCommit(Connection c, String lease, String batch) { return command(c, core -> core.beginCommit(c.generation, lease, batch)); }
    public CompletionStage<Integer> commitSucceeded(Connection c, String lease, String token) { return command(c, core -> core.commitSucceeded(c.generation, lease, token)); }
    public CompletionStage<Void> commitFailed(Connection c, String lease, String token) { return command(c, core -> { core.commitFailed(c.generation, lease, token); return null; }); }
    public CompletionStage<Integer> cancelBatch(Connection c, String lease, String batch) { return command(c, core -> core.cancelBatch(c.generation, lease, batch)); }
    public CompletionStage<Boolean> revokeJournal(Connection c, String lease) { return command(c, core -> core.revokeJournal(c.generation, lease)); }
    private void cancel(Connection c, String reason) {
        if (c.owner != this || c.cleaned || !c.cancelled.compareAndSet(false, true)) return;
        try { loop.execute(() -> finish(c, reason)); }
        catch (RejectedExecutionException stopped) { if (!c.cleaned) throw stopped; }
    }
    private void finish(Connection c, String reason) {
        onLoop(); if (c.cleaned) return;
        c.cleaned = true; c.cancelled.set(true); c.state = State.CLOSED;
        if (c.timer != null) c.timer.cancel();
        if (c.core != null) c.core.disconnect(c.generation, reason);
        // close must run even if disconnect throws (including revoked Android permission).
        RuntimeException closeFailure = null;
        if (c.link != null) {
            try { c.link.disconnect(); } catch (RuntimeException ignored) { }
            finally { try { c.link.close(); } catch (RuntimeException failure) { closeFailure = failure; } }
        }
        c.write = null;
        // An uncertain native close must not authorize a second GATT on this owner.
        if (closeFailure == null) active.compareAndSet(c, null);
        else reason += "; GATT close failed: " + reason(closeFailure);
        c.ready.completeExceptionally(new IllegalStateException(reason));
        if (closeFailure == null) c.closed.complete(null); else c.closed.completeExceptionally(closeFailure);
        try { listener.closed(c, reason); } catch (RuntimeException ignored) { }
        if (disposed.get()) loop.shutdown();
    }
    private static String reason(RuntimeException error) { return error.getClass().getSimpleName() + ": " + error.getMessage(); }
    @Override public synchronized void close() {
        if (!disposed.compareAndSet(false, true)) return;
        Connection c = active.get();
        if (c == null || c.cleaned) loop.execute(loop::shutdown); else cancel(c, "Transport disposed");
    }
}
