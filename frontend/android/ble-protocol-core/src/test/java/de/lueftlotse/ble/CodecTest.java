package de.lueftlotse.ble;

import com.google.gson.*;
import org.junit.Test;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import static de.lueftlotse.ble.Fixtures.*;
import static org.junit.Assert.*;

public class CodecTest {
    private JsonObject vectors() throws Exception {
        return JsonParser.parseString(new String(Files.readAllBytes(Paths.get(System.getProperty("sharedVectors"))), StandardCharsets.UTF_8)).getAsJsonObject();
    }
    @Test public void sharedInfoVectorsAndNegotiation() throws Exception {
        for (JsonElement item : vectors().getAsJsonArray("infoVectors")) {
            JsonObject v = item.getAsJsonObject(); byte[] bytes = Codec.unhex(v.get("hex").getAsString()); Codec.Info info = Codec.decodeInfo(bytes);
            assertEquals(v.get("minor").getAsInt(), info.minor); assertEquals(v.get("capabilities").getAsInt(), info.capabilities);
            assertEquals(ID, info.deviceId); assertArrayEquals(bytes, Codec.encodeInfo(info));
            assertEquals(info.minor == 1 && (info.capabilities & 16) != 0, info.supportsLiveSample());
        }
    }
    @Test public void sharedLiveVectorsBodyCrcFramesAndUint64() throws Exception {
        for (JsonElement item : vectors().getAsJsonArray("liveSampleVectors")) {
            JsonObject v = item.getAsJsonObject(); byte[] body = Codec.unhex(v.get("body").getAsString());
            Codec.Message message = Codec.decodeBody(0x8a, body);
            assertEquals(v.get("sampleCounter").getAsString(), message.big("sampleCounter").toString());
            assertEquals(v.get("uptimeMs").getAsString(), message.big("uptimeMs").toString());
            assertEquals(v.get("ppm").getAsLong(), message.number("ppm")); assertEquals(v.get("bootId").getAsString(), message.text("bootId"));
            assertArrayEquals(body, Codec.encodeBody(message)); int id = v.get("messageId").getAsInt();
            List<byte[]> frames = Wire.fragment(message, id, Wire.Direction.EVENTS); assertEquals(3, frames.size());
            StringBuilder logical = new StringBuilder(); Wire.Assembler assembler = new Wire.Assembler(Wire.Direction.EVENTS); Wire.Decoded decoded = null;
            for (int i = 0; i < frames.size(); i++) {
                assertEquals(v.getAsJsonArray("frames").get(i).getAsString(), Codec.hex(frames.get(i)));
                logical.append(Codec.hex(Arrays.copyOfRange(frames.get(i), 6, frames.get(i).length))); decoded = assembler.accept(frames.get(i), i);
            }
            assertEquals(v.get("logical").getAsString(), logical.toString()); assertNotNull(decoded); assertEquals(id, decoded.messageId);
            assertEquals(message.toBridge(), decoded.message.toBridge());
        }
    }
    @Test public void rejectsInfoVersionsCapabilitiesLengthsAndUuid() {
        for (int minor : new int[]{-1, 2, 255}) assertThrows(ProtocolException.class, () -> new Codec.Info(minor, ID, 0));
        for (int[] pair : new int[][]{{0, 16}, {1, 32}, {1, -1}, {0, 65535}}) {
            assertThrows(ProtocolException.class, () -> new Codec.Info(pair[0], ID, pair[1]));
            byte[] raw = info(0, 0); raw[1] = (byte) pair[0]; raw[18] = (byte) pair[1]; raw[19] = (byte) (pair[1] >>> 8);
            assertThrows(ProtocolException.class, () -> Codec.decodeInfo(raw));
        }
        byte[] major = info(1, 31); major[0] = 2; assertThrows(ProtocolException.class, () -> Codec.decodeInfo(major));
        byte[] minor = info(1, 31); minor[1] = 2; assertThrows(ProtocolException.class, () -> Codec.decodeInfo(minor));
        for (int length : new int[]{0, 19, 21, 200}) assertThrows(ProtocolException.class, () -> Codec.decodeInfo(new byte[length]));
        for (String id : new String[]{ID.replace("4677", "1677"), ID.replace("8899", "c899"), "bad", "00000000-0000-0000-0000-000000000000"})
            assertThrows(ProtocolException.class, () -> new Codec.Info(1, id, 0));
        byte[] wrongUuid = info(1, 0); wrongUuid[8] = 0x16; assertThrows(ProtocolException.class, () -> Codec.decodeInfo(wrongUuid));
    }
    @Test public void uint64UsesEntireRangeAndStrictDecimalStrings() {
        for (String value : new String[]{"0", "9007199254740993", "9223372036854775808", "18446744073709551615"}) {
            BigInteger parsed = UInt64.fromDecimal(value); assertEquals(value, UInt64.toDecimal(parsed));
            Codec.Message message = Codec.message(3, "afterSequence", parsed, "limit", 100);
            assertEquals(parsed, Codec.decodeBody(3, Codec.encodeBody(message)).big("afterSequence"));
            assertEquals(value, message.toBridge().get("afterSequence"));
        }
        for (String value : new String[]{"-1", "18446744073709551616", "01", "+1", "1.0", "1e3", " 1", "", "9999999999999999999999999"})
            assertThrows(ProtocolException.class, () -> UInt64.fromDecimal(value));
        assertThrows(ProtocolException.class, () -> live(ID, UInt64.MAX.add(n(1)), n(1)));
        assertThrows(ProtocolException.class, () -> live(ID, n(1), n(-1)));
        assertThrows(ProtocolException.class, () -> Codec.message(3, "afterSequence", Long.MAX_VALUE, "limit", 1));
    }
    @Test public void futureBridgeRejectsNumericUint64AndPreservesNestedValues() {
        Codec.Message original = Codec.message(0x83, "batchId", ID, "entry", ready(1, ID));
        Map<String, Object> bridge = new LinkedHashMap<>(original.toBridge()); bridge.remove("type");
        assertArrayEquals(Codec.encodeBody(original), Codec.encodeBody(Codec.fromBridge(0x83, bridge)));
        Map<String, Object> fields = new LinkedHashMap<>(); fields.put("afterSequence", "18446744073709551615"); fields.put("limit", 100);
        assertEquals(UInt64.MAX, Codec.fromBridge(3, fields).big("afterSequence"));
        for (Object bad : new Object[]{1L, 9007199254740993d, BigInteger.ONE, "01"}) {
            fields.put("afterSequence", bad); assertThrows(ProtocolException.class, () -> Codec.fromBridge(3, fields));
        }
    }
    @Test public void allMessagesHaveExactSizesAndRoundTripBothDirections() {
        Codec.Entry ready = ready(1, ID), undatable = Codec.entry(2, "sequence", n(2), "measurementId", OTHER, "bootId", ID, "segmentId", ID, "uptimeMs", n(0), "ppm", 1);
        Codec.Message[] messages = {
            Codec.message(1), Codec.message(2, "bootId", ID, "utcMs", n(0), "uncertaintyMs", 0xffffffffL),
            Codec.message(3, "afterSequence", n(0), "limit", 100), Codec.message(4, "batchId", ID, "throughSequence", n(3), "count", 1, "digest", new byte[32]),
            Codec.message(5, "batchId", ID), status(65535),
            Codec.message(0x81, "requestId", 0, "bootId", ID, "utcMs", n(-1), "uptimeMs", UInt64.MAX, "uncertaintyMs", 0), begin(0),
            Codec.message(0x83, "batchId", ID, "entry", ready), Codec.message(0x83, "batchId", ID, "entry", undatable), Codec.message(0x83, "batchId", ID, "entry", gap(1, 3)),
            Codec.message(0x84, "batchId", ID, "digest", new byte[32]), Codec.message(0x85, "requestId", 0, "bootId", ID, "firstUndated", n(1), "latest", n(3)),
            Codec.message(0x86, "entry", ready), accepted(0), Codec.message(0x88, "fromSequence", n(1), "toSequence", n(3), "reason", 2),
            Codec.message(0x89, "requestId", 0, "batchId", ID), live(1, 0), Codec.message(0xff, "requestId", 65535, "code", 7)
        };
        int[] sizes = {0, 28, 10, 58, 16, 52, 38, 36, 93, 85, 34, 48, 34, 77, 18, 17, 18, 36, 3};
        for (int i = 0; i < messages.length; i++) {
            Codec.Message m = messages[i]; byte[] body = Codec.encodeBody(m); assertEquals(sizes[i], body.length);
            assertEquals(m.toBridge(), Codec.decodeBody(m.type, body).toBridge());
            assertThrows(ProtocolException.class, () -> Codec.decodeBody(m.type, Arrays.copyOf(body, body.length + 1)));
            if (body.length > 0) assertThrows(ProtocolException.class, () -> Codec.decodeBody(m.type, Arrays.copyOf(body, body.length - 1)));
            Wire.Direction direction = m.type < 128 ? Wire.Direction.CONTROL : Wire.Direction.EVENTS;
            Wire.Assembler assembler = new Wire.Assembler(direction); Wire.Decoded decoded = null;
            for (byte[] frame : Wire.fragment(m, 19, direction)) { assertTrue(frame.length <= 20); decoded = assembler.accept(frame, 0); }
            assertNotNull(decoded); assertEquals(m.toBridge(), decoded.message.toBridge());
        }
    }
    @Test public void validatesFieldsFlagsReservedIdsAndRelationships() {
        for (int count : new int[]{0, -1, 101}) assertThrows(ProtocolException.class, () -> Codec.message(3, "afterSequence", n(0), "limit", count));
        assertThrows(ProtocolException.class, () -> Codec.message(3, "afterSequence", n(0), "limit", 1.5));
        for (int ppm : new int[]{0, 100001, -1}) assertThrows(ProtocolException.class, () -> Codec.message(0x8a, "bootId", ID, "sampleCounter", n(1), "uptimeMs", n(0), "ppm", ppm));
        assertThrows(ProtocolException.class, () -> live(0, 0)); assertThrows(ProtocolException.class, () -> ready(0, ID));
        assertThrows(ProtocolException.class, () -> gap(3, 1));
        assertThrows(ProtocolException.class, () -> Codec.message(0x86, "entry", gap(1, 1)));
        assertThrows(ProtocolException.class, () -> accepted(65535));
        assertThrows(ProtocolException.class, () -> Codec.decodeBody(6, new byte[0]));
        assertThrows(ProtocolException.class, () -> Codec.message(1, "extra", 0));
        assertThrows(ProtocolException.class, () -> Codec.message(3, "afterSequence", n(0)));
        for (int offset : new int[]{42, 51}) { byte[] bytes = Codec.encodeBody(status(0)); bytes[offset] = 2; assertThrows(ProtocolException.class, () -> Codec.decodeBody(0x80, bytes)); }
        for (int code : new int[]{0, 12}) assertThrows(ProtocolException.class, () -> Codec.message(0xff, "requestId", 65535, "code", code));
        byte[] reversed = Codec.encodeBody(status(0)); reversed[18] = 4; assertThrows(ProtocolException.class, () -> Codec.decodeBody(0x80, reversed));
        byte[] badReason = Codec.encodeEntry(gap(1, 3)); badReason[17] = 3; assertThrows(ProtocolException.class, () -> Codec.decodeEntry(badReason));
    }
    @Test public void utcEndpointsMatchExistingWireContract() {
        BigInteger[] values = {Codec.UTC_MIN, Codec.UTC_MAX}; String[] hex = {"0028d3ed7cc7ffff", "ffdb1fd277e60000"};
        for (int i = 0; i < values.length; i++) {
            Codec.Message m = Codec.message(2, "bootId", ID, "utcMs", values[i], "uncertaintyMs", 0);
            assertEquals(ID.replace("-", "") + hex[i] + "00000000", Codec.hex(Codec.encodeBody(m)));
            assertEquals(values[i], Codec.decodeBody(2, Codec.encodeBody(m)).big("utcMs"));
        }
        for (BigInteger bad : new BigInteger[]{Codec.UTC_MIN.subtract(n(1)), Codec.UTC_MAX.add(n(1))})
            assertThrows(ProtocolException.class, () -> Codec.message(2, "bootId", ID, "utcMs", bad, "uncertaintyMs", 0));
    }
    @Test public void canonicalDigestMatchesExistingIndependentReference() {
        assertEquals("4c4c2d42415443482d56310000112233445546778899aabbccddeeff000000000000000003000000000000000100030100000000000000030000000000000001",
                Codec.hex(Codec.canonicalBatch(begin(14), Collections.singletonList(gap(1, 3)))));
        assertEquals("d0ba1b3f83d9542c29418ebec645a09a893cddfb49eed5db3aee83cfc3fc5802", Codec.hex(Codec.batchDigest(begin(14), Collections.singletonList(gap(1, 3)))));
        assertArrayEquals(Codec.batchDigest(begin(14), Collections.singletonList(gap(1, 3))), Codec.batchDigest(begin(500), Collections.singletonList(gap(1, 3))));
    }
    @Test public void batchDigestRejectsHolesCountBoundariesAndDuplicateIds() {
        assertThrows(ProtocolException.class, () -> Codec.batchDigest(begin(0), Collections.emptyList()));
        assertThrows(ProtocolException.class, () -> Codec.batchDigest(begin(0), Collections.singletonList(gap(2, 3))));
        assertThrows(ProtocolException.class, () -> Codec.batchDigest(begin(0), Collections.singletonList(gap(1, 4))));
        Codec.Message two = Codec.message(0x82, "requestId", 0, "batchId", ID, "afterSequence", n(0), "throughSequence", n(2), "count", 2);
        assertThrows(ProtocolException.class, () -> Codec.batchDigest(two, Arrays.asList(ready(1, ID), ready(2, ID.toUpperCase(Locale.ROOT)))));
    }
    @Test public void immutableDigestAndBridgeViews() {
        byte[] digest = new byte[32]; Codec.Message m = Codec.message(0x84, "batchId", ID, "digest", digest); digest[0] = 1; m.bytes("digest")[0] = 2;
        assertEquals(0, m.bytes("digest")[0]); assertThrows(UnsupportedOperationException.class, () -> m.toBridge().put("batchId", OTHER));
    }
}
