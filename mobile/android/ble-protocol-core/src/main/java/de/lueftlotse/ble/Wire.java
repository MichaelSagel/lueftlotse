package de.lueftlotse.ble;

import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.zip.CRC32;
import static de.lueftlotse.ble.ProtocolException.require;

/** ATT-independent framing. Each assembler belongs to exactly one physical connection. */
public final class Wire {
    public enum Direction { CONTROL, EVENTS }
    private Wire() { }

    public static long crc32(byte[] data) { CRC32 crc = new CRC32(); crc.update(data); return crc.getValue(); }
    private static byte[] prefix(int type, int id) { return new byte[]{1, (byte) type, (byte) id, (byte) (id >>> 8)}; }
    private static void direction(int type, int id, Direction direction) {
        require(id >= 0 && id <= (direction == Direction.CONTROL ? 65534 : 65535), "Invalid/reserved message ID");
        require(direction == Direction.CONTROL ? type >= 1 && type <= 5 : type >= 0x80, "Wrong GATT direction");
        Codec.logicalSizes(type);
    }
    public static List<byte[]> fragment(Codec.Message message, int id, Direction direction) {
        direction(message.type, id, direction); byte[] body = Codec.encodeBody(message), prefix = prefix(message.type, id);
        ByteArrayOutputStream crcInput = new ByteArrayOutputStream(); Codec.append(crcInput, prefix); Codec.append(crcInput, body);
        long crc = crc32(crcInput.toByteArray()); byte[] logical = Arrays.copyOf(body, body.length + 4);
        for (int i = 0; i < 4; i++) logical[body.length + i] = (byte) (crc >>> (8 * i));
        require(logical.length <= 128, "Oversized logical message"); int count = (logical.length + 13) / 14;
        List<byte[]> frames = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            int length = Math.min(14, logical.length - 14 * i); byte[] frame = Arrays.copyOf(prefix, length + 6);
            frame[4] = (byte) i; frame[5] = (byte) count; System.arraycopy(logical, 14 * i, frame, 6, length); frames.add(frame);
        }
        return frames;
    }

    public static final class Decoded {
        public final int messageId;
        public final Codec.Message message;
        Decoded(int id, Codec.Message message) { this.messageId = id; this.message = message; }
    }

    public static final class Assembler {
        private final Direction direction;
        private final byte[] seen = new byte[8192], buffer = new byte[128];
        private int used, length, type, id, count, next;
        private boolean partial;
        private long started, lastNow = -1;
        public Assembler(Direction direction) { this.direction = Objects.requireNonNull(direction); }
        public int bufferedBytes() { return length; }
        public int consumedIds() { return used; }
        public boolean exhausted() { return used == (direction == Direction.CONTROL ? 65535 : 65536); }
        /** Call even when notifications stop; no sleeping thread or Android timer is needed. */
        public void tick(long now) {
            try {
                require(now >= 0 && now >= lastNow, "Invalid monotonic clock"); lastNow = now;
                require(!partial || now - started < 5000, "Fragment assembly timeout");
            } catch (ProtocolException e) { clearPartial(); throw e; }
        }
        public Decoded accept(byte[] frame, long now) {
            try { tick(now); return read(frame, now); }
            catch (ProtocolException e) { clearPartial(); throw e; }
        }
        private Decoded read(byte[] frame, long now) {
            require(frame != null && frame.length >= 7 && frame.length <= 20, "Invalid ATT length");
            require(frame[0] == 1, "Unsupported frame version"); int t = frame[1] & 255;
            int messageId = (frame[2] & 255) | (frame[3] & 255) << 8, index = frame[4] & 255, fragments = frame[5] & 255;
            direction(t, messageId, direction); int[] sizes = Codec.logicalSizes(t); boolean validCount = false;
            for (int size : sizes) if ((size + 13) / 14 == fragments) validCount = true;
            require(fragments >= 1 && fragments <= 10 && index < fragments && validCount && (index == fragments - 1 || frame.length == 20), "Invalid fragment size/count");
            if (!partial) {
                require(index == 0 && (seen[messageId >>> 3] & (1 << (messageId & 7))) == 0, "Unexpected fragment/reused ID");
                seen[messageId >>> 3] |= (byte) (1 << (messageId & 7)); used++;
                partial = true; type = t; id = messageId; count = fragments; started = now;
            }
            require(t == type && messageId == id && fragments == count && index == next && length + frame.length - 6 <= 128, "Interleaved/out of order fragment");
            System.arraycopy(frame, 6, buffer, length, frame.length - 6); length += frame.length - 6; next++;
            if (next != count) return null;
            boolean validLength = false; for (int size : sizes) if (size == length) validLength = true;
            require(validLength, "Wrong exact message length"); byte[] body = Arrays.copyOf(buffer, length - 4);
            ByteArrayOutputStream crcInput = new ByteArrayOutputStream(); Codec.append(crcInput, prefix(type, id)); Codec.append(crcInput, body);
            long expected = 0; for (int i = 0; i < 4; i++) expected |= (long) (buffer[length - 4 + i] & 255) << (8 * i);
            require(crc32(crcInput.toByteArray()) == expected, "CRC mismatch");
            Decoded result = new Decoded(id, Codec.decodeBody(type, body)); clearPartial(); return result;
        }
        private void clearPartial() { partial = false; length = 0; next = 0; }
    }
}
