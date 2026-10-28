package de.lueftlotse.ble;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import static de.lueftlotse.ble.ProtocolException.require;

/** Exact v1.0/v1.1 wire formats. No negotiation, storage or transport side effects. */
public final class Codec {
    public static final String SERVICE = "9c6b1000-7a3e-4d9f-8b52-6e210f42a001";
    public static final String INFO = "9c6b1001-7a3e-4d9f-8b52-6e210f42a001";
    public static final String CONTROL = "9c6b1002-7a3e-4d9f-8b52-6e210f42a001";
    public static final String EVENTS = "9c6b1003-7a3e-4d9f-8b52-6e210f42a001";
    public static final int LIVE_SAMPLE_CAPABILITY = 0x10;
    public static final BigInteger UTC_MIN = BigInteger.valueOf(-62135596800000L);
    public static final BigInteger UTC_MAX = BigInteger.valueOf(253402300799999L);
    private Codec() { }

    private static String schema(int type) {
        switch (type) {
            case 1: return "";
            case 2: return "bootId:uuid utcMs:utc uncertaintyMs:u32";
            case 3: return "afterSequence:u64 limit:count";
            case 4: return "batchId:uuid throughSequence:sequence count:count digest:digest";
            case 5: return "batchId:uuid";
            case 0x80: return "requestId:request bootId:uuid oldest:u64 latest:u64 overwrittenThrough:u64 timeValid:bool firstUndated:u64 storageState:bool";
            case 0x81: return "requestId:request bootId:uuid utcMs:utc uptimeMs:u64 uncertaintyMs:u32";
            case 0x82: return "requestId:request batchId:uuid afterSequence:u64 throughSequence:sequence count:count";
            case 0x83: return "batchId:uuid";
            case 0x84: return "batchId:uuid digest:digest";
            case 0x85: return "requestId:request bootId:uuid firstUndated:sequence latest:sequence";
            case 0x86: return "";
            case 0x87: case 0x89: return "requestId:request batchId:uuid";
            case 0x88: return "fromSequence:sequence toSequence:sequence reason:reason";
            case 0x8a: return "bootId:uuid sampleCounter:u64 uptimeMs:u64 ppm:ppm";
            case 0xff: return "requestId:request code:error";
            default: throw new ProtocolException("Unknown message type");
        }
    }

    private static String entrySchema(int tag) {
        String common = "sequence:sequence measurementId:uuid bootId:uuid segmentId:uuid uptimeMs:u64 ";
        switch (tag) {
            case 1: return common + "utcMs:utc ppm:ppm";
            case 2: return common + "ppm:ppm";
            case 3: return "fromSequence:sequence toSequence:sequence reason:reason";
            default: throw new ProtocolException("Unknown entry tag");
        }
    }

    private static String[] fields(String schema) { return schema.isEmpty() ? new String[0] : schema.split(" "); }
    private static int width(String kind) {
        switch (kind) {
            case "uuid": return 16;
            case "digest": return 32;
            case "u64": case "sequence": case "utc": return 8;
            case "u32": case "ppm": return 4;
            case "count": case "request": return 2;
            default: return 1;
        }
    }

    public static final class Info {
        public final int major = 1, minor, capabilities;
        public final String deviceId;
        public Info(int minor, String deviceId, int capabilities) {
            require(minor == 0 || minor == 1, "Unsupported Info version");
            require(capabilities >= 0 && (capabilities & ~(minor == 0 ? 15 : 31)) == 0, "Unknown capability bits");
            this.deviceId = uuid(deviceId); this.minor = minor; this.capabilities = capabilities;
        }
        public boolean supportsLiveSample() { return minor == 1 && (capabilities & 16) != 0; }
        public boolean supports(int mask) { return (capabilities & mask) == mask; }
    }

    /** Immutable fields; byte arrays are copied on ingress and egress. */
    public abstract static class Values {
        private final Map<String, Object> values;
        Values(Map<String, ?> source) {
            Map<String, Object> copy = new LinkedHashMap<>();
            for (Map.Entry<String, ?> e : source.entrySet()) {
                Object value = e.getValue();
                if (value instanceof byte[]) value = ((byte[]) value).clone();
                if (value instanceof Integer) value = ((Integer) value).longValue();
                copy.put(e.getKey(), value);
            }
            values = Collections.unmodifiableMap(copy);
        }
        public BigInteger big(String field) { return (BigInteger) values.get(field); }
        public long number(String field) { return (Long) values.get(field); }
        public String text(String field) { return (String) values.get(field); }
        public byte[] bytes(String field) { return ((byte[]) values.get(field)).clone(); }
        public Entry entry() { return (Entry) values.get("entry"); }
        public boolean has(String field) { return values.containsKey(field); }
        final Object get(String field) { return values.get(field); }
        final int size() { return values.size(); }
        public Map<String, Object> toBridge() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put(this instanceof Message ? "type" : "tag", this instanceof Message ? ((Message) this).type : ((Entry) this).tag);
            for (Map.Entry<String, Object> e : values.entrySet()) {
                Object value = e.getValue();
                if (value instanceof BigInteger) value = value.toString();
                else if (value instanceof byte[]) value = hex((byte[]) value);
                else if (value instanceof Entry) value = ((Entry) value).toBridge();
                result.put(e.getKey(), value);
            }
            return Collections.unmodifiableMap(result);
        }
    }

    public static final class Message extends Values {
        public final int type;
        private Message(int type, Map<String, ?> values) { super(values); this.type = type; encodeBody(this); }
    }
    public static final class Entry extends Values {
        public final int tag;
        private Entry(int tag, Map<String, ?> values) { super(values); this.tag = tag; encodeEntry(this); }
    }
    public static Message message(int type, Object... pairs) { return new Message(type, pairs(pairs)); }
    public static Entry entry(int tag, Object... pairs) { return new Entry(tag, pairs(pairs)); }
    private static Map<String, Object> pairs(Object[] pairs) {
        require(pairs.length % 2 == 0, "Expected field/value pairs");
        Map<String, Object> result = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            require(pairs[i] instanceof String && pairs[i + 1] != null && !result.containsKey(pairs[i]), "Invalid/duplicate field");
            result.put((String) pairs[i], pairs[i + 1]);
        }
        return result;
    }

    public static Message fromBridge(int type, Map<String, ?> fields) {
        return new Message(type, bridgeFields(schema(type), fields, type == 0x83 || type == 0x86));
    }
    private static Map<String, Object> bridgeFields(String schema, Map<String, ?> input, boolean withEntry) {
        Map<String, Object> result = new LinkedHashMap<>();
        require(input.size() == fields(schema).length + (withEntry ? 1 : 0), "Unexpected bridge fields");
        for (String f : fields(schema)) {
            String[] p = f.split(":"); Object value = input.get(p[0]);
            if (p[1].equals("u64") || p[1].equals("sequence") || p[1].equals("utc")) {
                require(value instanceof String, "64-bit bridge values must be decimal strings");
                if (p[1].equals("utc")) {
                    require(((String) value).matches("0|-?[1-9][0-9]{0,14}"), "Invalid UTC decimal string");
                    value = new BigInteger((String) value);
                } else value = UInt64.fromDecimal((String) value);
            } else if (p[1].equals("digest")) {
                require(value instanceof String && ((String) value).length() == 64, "Expected digest hex");
                value = unhex((String) value);
            }
            result.put(p[0], value);
        }
        if (withEntry) {
            require(input.get("entry") instanceof Map, "Expected bridge entry");
            Map<?, ?> entry = (Map<?, ?>) input.get("entry");
            Object rawTag = entry.get("tag");
            require(rawTag instanceof Integer || rawTag instanceof Long, "Invalid entry tag");
            long tag = ((Number) rawTag).longValue(); require(tag >= 1 && tag <= 3, "Invalid entry tag");
            Map<String, Object> entryFields = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : entry.entrySet()) if (!e.getKey().equals("tag")) {
                require(e.getKey() instanceof String, "Invalid entry field"); entryFields.put((String) e.getKey(), e.getValue());
            }
            result.put("entry", new Entry((int) tag, bridgeFields(entrySchema((int) tag), entryFields, false)));
        }
        return result;
    }

    public static byte[] encodeInfo(Info info) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(20);
        out.write(1); out.write(info.minor); append(out, unhex(info.deviceId.replace("-", "")));
        out.write(info.capabilities); out.write(info.capabilities >>> 8); return out.toByteArray();
    }
    public static Info decodeInfo(byte[] data) {
        require(data.length == 20, "Info must be 20 bytes");
        require(data[0] == 1, "Unsupported Info version");
        return new Info(data[1] & 255, uuidBytes(Arrays.copyOfRange(data, 2, 18)), (data[18] & 255) | (data[19] & 255) << 8);
    }

    public static byte[] encodeBody(Message m) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); boolean withEntry = m.type == 0x83 || m.type == 0x86;
        encodeFields(schema(m.type), m, out, withEntry ? 1 : 0);
        if (withEntry) { require(m.get("entry") instanceof Entry, "Expected entry"); append(out, encodeEntry(m.entry())); }
        if (m.has("requestId") && m.type != 0x80 && m.type != 0xff) require(m.number("requestId") != 65535, "Reserved request ID");
        switch (m.type) {
            case 0x80:
                BigInteger oldest = m.big("oldest"), latest = m.big("latest"), overwritten = m.big("overwrittenThrough"), first = m.big("firstUndated");
                require((oldest.signum() == 0 && latest.signum() == 0) || (oldest.signum() > 0 && oldest.compareTo(latest) <= 0), "Invalid journal bounds");
                require(overwritten.compareTo(latest) <= 0 && (overwritten.signum() == 0 || overwritten.compareTo(oldest) < 0), "Invalid overwrite bounds");
                require(first.signum() == 0 || (first.compareTo(oldest) >= 0 && first.compareTo(latest) <= 0), "Invalid pending sequence"); break;
            case 0x82:
                BigInteger span = m.big("throughSequence").subtract(m.big("afterSequence"));
                require(span.signum() > 0 && span.compareTo(BigInteger.valueOf(m.number("count"))) >= 0, "Invalid batch boundaries"); break;
            case 0x85: require(m.big("firstUndated").compareTo(m.big("latest")) <= 0, "Invalid UNDATED bounds"); break;
            case 0x86: require(m.entry().tag == 1, "LIVE_READY requires READY"); break;
            case 0x88: checkGap(m); break;
            case 0x8a: require(m.big("sampleCounter").signum() > 0, "Sample counter starts at one"); break;
            default: break;
        }
        return out.toByteArray();
    }
    public static Message decodeBody(int type, byte[] body) {
        boolean sizeOk = false; for (int n : logicalSizes(type)) if (n == body.length + 4) sizeOk = true;
        require(sizeOk, "Wrong exact body length"); Reader reader = new Reader(body);
        Map<String, Object> values = reader.fields(schema(type));
        if (type == 0x83 || type == 0x86) values.put("entry", decodeEntry(reader.rest()));
        reader.end(); return new Message(type, values);
    }
    public static byte[] encodeEntry(Entry entry) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); out.write(entry.tag);
        encodeFields(entrySchema(entry.tag), entry, out, 0); if (entry.tag == 3) checkGap(entry); return out.toByteArray();
    }
    public static Entry decodeEntry(byte[] body) {
        require(body.length == 18 || body.length == 69 || body.length == 77, "Wrong entry length");
        Reader reader = new Reader(body); int tag = reader.data[reader.offset++] & 255;
        Map<String, Object> values = reader.fields(entrySchema(tag)); reader.end(); return new Entry(tag, values);
    }
    private static void checkGap(Values values) { require(values.big("fromSequence").compareTo(values.big("toSequence")) <= 0, "Reversed GAP"); }
    public static int[] logicalSizes(int type) {
        if (type == 0x83) return new int[]{38, 89, 97}; if (type == 0x86) return new int[]{81};
        int n = 4; for (String f : fields(schema(type))) n += width(f.split(":")[1]); return new int[]{n};
    }

    private static void encodeFields(String schema, Values values, ByteArrayOutputStream out, int extra) {
        String[] fields = fields(schema); require(values.size() == fields.length + extra, "Missing/unexpected fields");
        for (String f : fields) {
            String[] p = f.split(":"); Object value = values.get(p[0]); String kind = p[1]; int n = width(kind);
            validate(kind, value);
            if (kind.equals("uuid")) append(out, unhex(((String) value).replace("-", "")));
            else if (kind.equals("digest")) append(out, (byte[]) value);
            else {
                BigInteger number = value instanceof BigInteger ? (BigInteger) value : BigInteger.valueOf((Long) value);
                for (int i = 0; i < n; i++) out.write(number.shiftRight(8 * i).intValue() & 255);
            }
        }
    }
    private static void validate(String kind, Object value) {
        if (kind.equals("uuid")) { require(value instanceof String, "Expected UUID v4"); uuid((String) value); return; }
        if (kind.equals("digest")) { require(value instanceof byte[] && ((byte[]) value).length == 32, "Expected 32-byte digest"); return; }
        if (width(kind) == 8) {
            require(value instanceof BigInteger, "64-bit integer must be BigInteger"); BigInteger n = (BigInteger) value;
            if (kind.equals("utc")) require(n.compareTo(UTC_MIN) >= 0 && n.compareTo(UTC_MAX) <= 0, "UTC outside backend range");
            else UInt64.checked(n);
            if (kind.equals("sequence")) require(n.signum() > 0, "Sequence starts at one"); return;
        }
        require(value instanceof Long, "Expected integer (not floating point)"); long n = (Long) value;
        require(n >= 0 && n <= (width(kind) == 4 ? 0xffffffffL : width(kind) == 2 ? 65535 : 255), "Unsigned integer overflow");
        switch (kind) {
            case "count": require(n >= 1 && n <= 100, "Count must be 1..100"); break;
            case "ppm": require(n >= 1 && n <= 100000, "PPM must be 1..100000"); break;
            case "bool": require(n <= 1, "Invalid flag"); break;
            case "reason": require(n == 1 || n == 2, "Unknown GAP reason"); break;
            case "error": require(n >= 1 && n <= 11, "Unknown error code"); break;
            default: break;
        }
    }
    private static final class Reader {
        final byte[] data; int offset;
        Reader(byte[] data) { this.data = data; }
        Map<String, Object> fields(String schema) {
            Map<String, Object> result = new LinkedHashMap<>();
            for (String f : Codec.fields(schema)) {
                String[] p = f.split(":"); String kind = p[1]; int n = width(kind);
                require(offset + n <= data.length, "Truncated field"); byte[] bytes = Arrays.copyOfRange(data, offset, offset + n); offset += n;
                Object value;
                if (kind.equals("uuid")) value = uuidBytes(bytes);
                else if (kind.equals("digest")) value = bytes;
                else {
                    for (int i = 0; i < n / 2; i++) { byte t = bytes[i]; bytes[i] = bytes[n - 1 - i]; bytes[n - 1 - i] = t; }
                    BigInteger big = kind.equals("utc") ? new BigInteger(bytes) : new BigInteger(1, bytes);
                    value = n == 8 ? big : (Object) big.longValue();
                }
                validate(kind, value); result.put(p[0], value);
            }
            return result;
        }
        byte[] rest() { byte[] result = Arrays.copyOfRange(data, offset, data.length); offset = data.length; return result; }
        void end() { require(offset == data.length, "Unexpected trailing bytes"); }
    }

    public static String uuid(String value) {
        require(value != null && value.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"), "Expected UUID v4");
        return value.toLowerCase(Locale.ROOT);
    }
    private static String uuidBytes(byte[] bytes) {
        String h = hex(bytes); return uuid(h.substring(0, 8) + "-" + h.substring(8, 12) + "-" + h.substring(12, 16) + "-" + h.substring(16, 20) + "-" + h.substring(20));
    }
    public static String hex(byte[] bytes) {
        char[] chars = new char[bytes.length * 2]; String digits = "0123456789abcdef";
        for (int i = 0; i < bytes.length; i++) { chars[2 * i] = digits.charAt((bytes[i] & 255) >>> 4); chars[2 * i + 1] = digits.charAt(bytes[i] & 15); }
        return new String(chars);
    }
    public static byte[] unhex(String value) {
        require(value != null && value.length() % 2 == 0 && value.matches("[0-9a-fA-F]*"), "Invalid hex");
        byte[] bytes = new byte[value.length() / 2]; for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(2 * i, 2 * i + 2), 16); return bytes;
    }
    static void append(ByteArrayOutputStream out, byte[] bytes) { out.write(bytes, 0, bytes.length); }

    public static byte[] canonicalBatch(Message begin, List<Entry> entries) {
        require(begin.type == 0x82 && entries.size() == begin.number("count") && entries.size() <= 100, "Invalid batch count");
        ByteArrayOutputStream out = new ByteArrayOutputStream(); append(out, "LL-BATCH-V1\0".getBytes(StandardCharsets.US_ASCII));
        byte[] header = encodeBody(begin); out.write(header, 2, header.length - 2);
        BigInteger next = begin.big("afterSequence").add(BigInteger.ONE); Set<String> ids = new HashSet<>();
        for (Entry entry : entries) {
            require(next.equals(entry.big(entry.tag == 3 ? "fromSequence" : "sequence")), "Noncontiguous batch");
            next = entry.big(entry.tag == 3 ? "toSequence" : "sequence").add(BigInteger.ONE);
            if (entry.tag != 3) require(ids.add(uuid(entry.text("measurementId"))), "Duplicate measurement ID");
            append(out, encodeEntry(entry));
        }
        require(next.subtract(BigInteger.ONE).equals(begin.big("throughSequence")), "Wrong final boundary"); return out.toByteArray();
    }
    public static byte[] batchDigest(Message begin, List<Entry> entries) {
        try { return MessageDigest.getInstance("SHA-256").digest(canonicalBatch(begin, entries)); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException("JVM must implement SHA-256", e); }
    }
}
