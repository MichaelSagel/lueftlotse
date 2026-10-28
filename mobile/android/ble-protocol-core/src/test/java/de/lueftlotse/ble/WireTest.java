package de.lueftlotse.ble;

import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static de.lueftlotse.ble.Fixtures.*;
import static org.junit.Assert.*;

public class WireTest {
    @Test public void crcStandardCheckValue() { assertEquals(0xcbf43926L, Wire.crc32("123456789".getBytes(StandardCharsets.US_ASCII))); }
    @Test public void crcCoversHeaderAndBodyAndConsumesFailedId() {
        for (int offset : new int[]{2, 6, 9}) {
            Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.CONTROL);
            byte[] frame = Wire.fragment(Codec.message(1), 7, Wire.Direction.CONTROL).get(0); frame[offset] ^= 1;
            assertThrows(ProtocolException.class, () -> assembler.accept(frame, 0));
            assertEquals(0, assembler.bufferedBytes()); assertEquals(1, assembler.consumedIds());
            byte[] retry = Wire.fragment(Codec.message(1), frame[2] & 255, Wire.Direction.CONTROL).get(0);
            assertThrows(ProtocolException.class, () -> assembler.accept(retry, 1));
        }
    }
    @Test public void rejectsOutOfOrderDuplicatesAndInterleaving() {
        List<byte[]> frames = Wire.fragment(live(1, 0), 7, Wire.Direction.EVENTS);
        for (byte[] bad : Arrays.asList(frames.get(0), frames.get(2), Wire.fragment(live(2, 1), 8, Wire.Direction.EVENTS).get(0))) {
            Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.EVENTS); assertNull(assembler.accept(frames.get(0), 0));
            assertThrows(ProtocolException.class, () -> assembler.accept(bad, 1)); assertEquals(0, assembler.bufferedBytes());
            assertThrows(ProtocolException.class, () -> assembler.accept(frames.get(0), 2));
        }
        assertThrows(ProtocolException.class, () -> new Wire.Assembler(Wire.Direction.EVENTS).accept(frames.get(1), 0));
    }
    @Test public void fragmentDeadlineDoesNotExtendWithTrafficAndTickExpiresWithoutInput() {
        List<byte[]> frames = Wire.fragment(live(1, 0), 2, Wire.Direction.EVENTS);
        Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.EVENTS); assembler.accept(frames.get(0), 10); assembler.accept(frames.get(1), 5009);
        assertThrows(ProtocolException.class, () -> assembler.tick(5010)); assertEquals(0, assembler.bufferedBytes());
        assertThrows(ProtocolException.class, () -> assembler.accept(frames.get(0), 5011));
        assertThrows(ProtocolException.class, () -> assembler.tick(0));
    }
    @Test public void rejectsSizesCountsVersionsUnknownTypesAndTrailingBytes() {
        byte[] good = Wire.fragment(live(1, 0), 0, Wire.Direction.EVENTS).get(0);
        for (int length : new int[]{0, 6, 19, 21, 1000}) {
            byte[] bad = Arrays.copyOf(good, length); assertThrows(ProtocolException.class, () -> new Wire.Assembler(Wire.Direction.EVENTS).accept(bad, 0));
        }
        for (int[] change : new int[][]{{0, 2}, {1, 0x8b}, {4, 3}, {5, 0}, {5, 2}, {5, 11}}) {
            byte[] bad = good.clone(); bad[change[0]] = (byte) change[1]; assertThrows(ProtocolException.class, () -> new Wire.Assembler(Wire.Direction.EVENTS).accept(bad, 0));
        }
        List<byte[]> frames = Wire.fragment(live(1, 0), 0, Wire.Direction.EVENTS); Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.EVENTS);
        assembler.accept(frames.get(0), 0); assembler.accept(frames.get(1), 1);
        assertThrows(ProtocolException.class, () -> assembler.accept(Arrays.copyOf(frames.get(2), 19), 2));
    }
    @Test public void directionsAndReservedIdAreIndependent() {
        assertThrows(ProtocolException.class, () -> Wire.fragment(Codec.message(1), 65535, Wire.Direction.CONTROL));
        assertThrows(ProtocolException.class, () -> Wire.fragment(live(1, 0), 0, Wire.Direction.CONTROL));
        assertThrows(ProtocolException.class, () -> Wire.fragment(Codec.message(1), 0, Wire.Direction.EVENTS));
        for (int id : new int[]{-1, 65536}) assertThrows(ProtocolException.class, () -> Wire.fragment(live(1, 0), id, Wire.Direction.EVENTS));
        Wire.Assembler control = new Wire.Assembler(Wire.Direction.CONTROL), events = new Wire.Assembler(Wire.Direction.EVENTS);
        assertNotNull(control.accept(Wire.fragment(Codec.message(1), 7, Wire.Direction.CONTROL).get(0), 0));
        Wire.Decoded decoded = null; for (byte[] frame : Wire.fragment(live(1, 0), 7, Wire.Direction.EVENTS)) decoded = events.accept(frame, 0);
        assertNotNull(decoded); assertEquals(7, decoded.messageId);
        for (byte[] frame : Wire.fragment(live(2, 0), 65535, Wire.Direction.EVENTS)) decoded = events.accept(frame, 0);
        assertNotNull(decoded); assertEquals(65535, decoded.messageId);
    }
    @Test public void idsNeedNotIncreaseButNeverWrapOrResetWithinAssembler() {
        Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.CONTROL);
        for (int id = 65534; id >= 0; id--) assembler.accept(Wire.fragment(Codec.message(1), id, Wire.Direction.CONTROL).get(0), 0);
        assertTrue(assembler.exhausted()); assertEquals(65535, assembler.consumedIds());
        byte[] first = Wire.fragment(Codec.message(1), 0, Wire.Direction.CONTROL).get(0);
        assertThrows(ProtocolException.class, () -> assembler.accept(first, 0));
        assertNotNull(new Wire.Assembler(Wire.Direction.CONTROL).accept(first, 0));
    }
}
