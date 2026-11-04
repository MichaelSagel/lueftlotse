package de.lueftlotse.ble;

import java.math.BigInteger;
import java.util.*;
import static org.junit.Assert.*;

final class Fixtures {
    static final String ID = "00112233-4455-4677-8899-aabbccddeeff";
    static final String OTHER = "10112233-4455-4677-8899-aabbccddeeff";
    static BigInteger n(long value) { return BigInteger.valueOf(value); }
    static Codec.Message status(int request) { return status(request, ID, 3); }
    static Codec.Message status(int request, String boot, long latest) {
        return Codec.message(0x80, "requestId", request, "bootId", boot, "oldest", n(latest == 0 ? 0 : 1), "latest", n(latest),
                "overwrittenThrough", n(0), "timeValid", 1, "firstUndated", n(0), "storageState", 0);
    }
    static Codec.Message live(long counter, long uptime) { return live(ID, n(counter), n(uptime)); }
    static Codec.Message live(String boot, BigInteger counter, BigInteger uptime) {
        return Codec.message(0x8a, "bootId", boot, "sampleCounter", counter, "uptimeMs", uptime, "ppm", 650);
    }
    static Codec.Entry gap(long from, long to) { return Codec.entry(3, "fromSequence", n(from), "toSequence", n(to), "reason", 1); }
    static Codec.Entry ready(long sequence, String id) {
        return Codec.entry(1, "sequence", n(sequence), "measurementId", id, "bootId", ID, "segmentId", ID, "uptimeMs", UInt64.MAX, "utcMs", n(-1), "ppm", 650);
    }
    static Codec.Message begin(int request) {
        return Codec.message(0x82, "requestId", request, "batchId", ID, "afterSequence", n(0), "throughSequence", n(3), "count", 1);
    }
    static Codec.Message accepted(int request) { return Codec.message(0x87, "requestId", request, "batchId", ID); }
    static byte[] info(int minor, int caps) { return Codec.encodeInfo(new Codec.Info(minor, ID, caps)); }

    static final class Link {
        long now;
        int eventId;
        final ProtocolSession core = new ProtocolSession(() -> now);
        String generation;
        Wire.Assembler control = new Wire.Assembler(Wire.Direction.CONTROL);
        void open(int minor, int caps) {
            generation = core.open(info(minor, caps)); eventId = 0; control = new Wire.Assembler(Wire.Direction.CONTROL);
        }
        void ready() { open(1, 31); handshake(); }
        void handshake() {
            Wire.Decoded write = writeMessage(); assertEquals(1, write.message.type); send(status(write.messageId));
            assertEquals(ProtocolSession.State.READY, core.state()); assertEquals(ProtocolSession.Kind.READY, core.pollEvent().kind);
        }
        void send(Codec.Message message) { sendWithId(message, eventId++); }
        void sendWithId(Codec.Message message, int id) {
            for (byte[] frame : Wire.fragment(message, id, Wire.Direction.EVENTS)) core.receive(generation, frame);
        }
        Wire.Decoded writeMessage() {
            ProtocolSession.Write first = core.takeWrite(generation); assertNotNull("Expected queued write", first); return finish(first);
        }
        Wire.Decoded finish(ProtocolSession.Write write) {
            Wire.Decoded decoded = null;
            int id = write.messageId, count = write.frame()[5] & 255;
            for (int i = write.fragmentIndex; i < count; i++) {
                assertNotNull(write); assertEquals(id, write.messageId); assertEquals(i, write.fragmentIndex);
                decoded = control.accept(write.frame(), now); assertTrue(core.writeCompleted(generation, write.token, true));
                if (i + 1 < count) write = core.takeWrite(generation);
            }
            assertNotNull(decoded); return decoded;
        }
        ProtocolSession.Batch batch(String lease) {
            int id = core.fetch(generation, lease, n(0), 100); assertEquals(id, writeMessage().messageId); packet(id);
            ProtocolSession.Event event = core.pollEvent(); assertNotNull(event); assertEquals(ProtocolSession.Kind.BATCH, event.kind); return event.batch;
        }
        void packet(int request) {
            Codec.Message begin = begin(request); send(begin); send(Codec.message(0x83, "batchId", ID, "entry", gap(1, 3)));
            send(Codec.message(0x84, "batchId", ID, "digest", Codec.batchDigest(begin, Collections.singletonList(gap(1, 3)))));
        }
        void assertClosed() {
            assertEquals(ProtocolSession.State.CLOSED, core.state()); assertNull(core.takeWrite(generation)); assertEquals(0, core.pendingResponses());
        }
    }
}
