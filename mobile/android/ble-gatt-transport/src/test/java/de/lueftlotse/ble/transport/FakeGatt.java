package de.lueftlotse.ble.transport;

import de.lueftlotse.ble.*;
import java.math.BigInteger;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.Assert.*;

final class FakeGatt {
    static final String ADDRESS = "01:23:45:67:89:AB", ID = "00112233-4455-4677-8899-aabbccddeeff", OTHER = "10112233-4455-4677-8899-aabbccddeeff";
    static BigInteger n(long value) { return BigInteger.valueOf(value); }
    static byte[] info() { return Codec.encodeInfo(new Codec.Info(1, ID, 31)); }
    static Codec.Message status(int request) {
        return Codec.message(0x80, "requestId", request, "bootId", ID, "oldest", n(1), "latest", n(3), "overwrittenThrough", n(0), "timeValid", 1, "firstUndated", n(0), "storageState", 0);
    }
    static Codec.Message sample(long counter) { return Codec.message(0x8a, "bootId", ID, "sampleCounter", n(counter), "uptimeMs", n(counter * 5000), "ppm", 650); }

    static final class Loop implements SerialLoop {
        static final class Alarm implements Timer {
            long due; Runnable task; boolean cancelled;
            public void cancel() { cancelled = true; }
        }
        final Deque<Runnable> queue = new ArrayDeque<>();
        final List<Alarm> alarms = new ArrayList<>();
        long time;
        boolean running, stopped;
        Runnable beforeEnqueue;
        public void execute(Runnable task) {
            Runnable hook = beforeEnqueue; beforeEnqueue = null; if (hook != null) hook.run();
            if (stopped) throw new RejectedExecutionException(); queue.addLast(task);
        }
        public Timer schedule(Runnable task, long delay) { assertTrue(running); Alarm alarm = new Alarm(); alarm.due = time + delay; alarm.task = task; alarms.add(alarm); return alarm; }
        public long now() { assertTrue("Clock must be read on owner loop", running); return time; }
        public boolean isOnLoop() { return running; }
        public void shutdown() { assertTrue(running); stopped = true; }
        void run() {
            int remaining = 10000; running = true;
            try { while (!queue.isEmpty()) { assertTrue("Runaway queue", remaining-- > 0); queue.removeFirst().run(); } }
            finally { running = false; }
        }
        void advance(long ms) {
            time += ms;
            for (Iterator<Alarm> it = alarms.iterator(); it.hasNext();) {
                Alarm alarm = it.next();
                if (alarm.cancelled) it.remove();
                else if (alarm.due <= time) { it.remove(); queue.addLast(alarm.task); }
            }
            run();
        }
        long activeTimers() { return alarms.stream().filter(alarm -> !alarm.cancelled).count(); }
    }
    static final class Boundary implements GattBoundary {
        final Loop loop;
        final List<String> calls = new ArrayList<>();
        final List<Link> links = new ArrayList<>();
        String reject, throwing;
        boolean returnNull;
        Runnable connectHook;
        Boundary(Loop loop) { this.loop = loop; }
        public Link connect(String address, Callbacks callbacks) {
            assertTrue(loop.running); calls.add("connect");
            if ("connect".equals(throwing)) throw new SecurityException("Bluetooth permission missing");
            Link link = new Link(callbacks); links.add(link);
            if (connectHook != null) connectHook.run();
            return returnNull ? null : link;
        }
        final class Link implements GattBoundary.Link {
            final Callbacks callback;
            final List<Sent> sent = new ArrayList<>();
            String pending;
            int disconnects, closes, eventId;
            Link(Callbacks callback) { this.callback = callback; }
            boolean call(String name, boolean asynchronous) {
                assertTrue("Native operation off loop", loop.running); assertEquals(0, closes); calls.add(name);
                if (name.equals(throwing)) throw new SecurityException(name);
                if (name.equals(reject)) return false;
                if (asynchronous) { assertNull("Two concurrent native operations", pending); pending = name; }
                return true;
            }
            public boolean discover() { return call("discover", true); }
            public boolean validateProfile() { return call("profile", false); }
            public boolean readInfo() { return call("info", true); }
            public boolean enableLocalNotifications() { return call("notify", false); }
            public boolean writeNotificationCccd() { return call("cccd", true); }
            public boolean writeControl(byte[] bytes, String token) {
                if (!call("control-with-response", true)) return false;
                sent.add(new Sent(bytes.clone(), token)); return true;
            }
            public void disconnect() { assertTrue(loop.running); disconnects++; calls.add("disconnect"); if ("disconnect".equals(throwing)) throw new SecurityException(); }
            public void close() { assertTrue(loop.running); closes++; calls.add("close"); if ("close".equals(throwing)) throw new SecurityException(); }
            void connected() { callback.connection(0, GattBoundary.CONNECTED); loop.run(); }
            void discovered() { pending = null; callback.discovered(0); loop.run(); }
            void read(byte[] bytes) { pending = null; callback.info(0, bytes); loop.run(); }
            void subscribed() { pending = null; callback.subscribed(0); loop.run(); }
            void ackWrite() { Sent write = sent.get(sent.size() - 1); pending = null; callback.written(write.token, 0); loop.run(); }
            void send(Codec.Message message) {
                for (byte[] bytes : Wire.fragment(message, eventId++, Wire.Direction.EVENTS)) callback.events(bytes);
                loop.run();
            }
            void finishWrites() { int limit = 100; while ("control-with-response".equals(pending)) { assertTrue(limit-- > 0); ackWrite(); } }
        }
    }
    static final class Sent {
        final byte[] bytes; final String token;
        Sent(byte[] bytes, String token) { this.bytes = bytes; this.token = token; }
        int id() { return (bytes[2] & 255) | (bytes[3] & 255) << 8; }
    }
    static final class Harness {
        final Loop loop = new Loop(); final Boundary boundary = new Boundary(loop);
        final List<ProtocolSession.Event> events = new ArrayList<>();
        final List<Codec.Message> live = new ArrayList<>(); final List<String> reasons = new ArrayList<>();
        Runnable eventHook;
        final GattTransport transport = new GattTransport(boundary, loop, new GattTransport.Listener() {
            public void event(GattTransport.Connection c, ProtocolSession.Event e) { assertTrue(loop.running); events.add(e); if (eventHook != null) eventHook.run(); }
            public void live(GattTransport.Connection c, Codec.Message m) { assertTrue(loop.running); live.add(m); }
            public void closed(GattTransport.Connection c, String reason) { assertTrue(loop.running); reasons.add(reason); }
        });
        GattTransport.Connection connection;
        Boundary.Link link;
        void start() { connection = transport.connect(ADDRESS, ID); loop.run(); link = boundary.links.get(boundary.links.size() - 1); }
        void throughInfo() { start(); link.connected(); link.discovered(); link.read(info()); }
        void handshake() { throughInfo(); link.subscribed(); }
        void ready() { handshake(); link.finishWrites(); link.send(status(0)); assertEquals(GattTransport.State.READY, connection.state()); assertEquals(ID, connection.ready().toCompletableFuture().join().deviceId); }
        <T> T await(CompletionStage<T> future) { loop.run(); return future.toCompletableFuture().join(); }
        void closed() {
            assertEquals(GattTransport.State.CLOSED, connection.state()); assertTrue(connection.closed().toCompletableFuture().isDone());
            assertEquals(1, link.disconnects); assertEquals(1, link.closes); assertEquals(0, loop.activeTimers());
        }
    }
}
