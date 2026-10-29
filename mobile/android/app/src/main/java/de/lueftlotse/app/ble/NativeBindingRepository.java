package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.io.*;
import java.math.BigInteger;
import java.util.*;
import java.util.zip.CRC32;

/** The sole writer after explicit migration. No cache: failed/uncertain IO is never absence. */
public final class NativeBindingRepository {
    public interface Storage {
        /** null means ENOENT only; corrupt/unreadable data must throw. */
        byte[] read() throws IOException;
        /** Atomic replacement, synced to disk before returning. */
        void write(byte[] value) throws IOException;
    }
    public static final class Binding {
        public final String deviceId, bleAddress;
        public final boolean connectionEnabled;
        public Binding(String deviceId, String address, boolean enabled) {
            this.deviceId = Codec.uuid(deviceId);
            if (address == null || !address.matches("(?i)([0-9a-f]{2}:){5}[0-9a-f]{2}")) throw new IllegalArgumentException("Ungültige BLE-Adresse");
            bleAddress = address.toUpperCase(Locale.ROOT); connectionEnabled = enabled;
        }
        Map<String, Object> toBridge() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("version", 1); result.put("deviceId", deviceId); result.put("bleAddress", bleAddress);
            result.put("connectionEnabled", connectionEnabled); return Collections.unmodifiableMap(result);
        }
    }
    public static final class Snapshot {
        public final boolean migrationComplete;
        public final BigInteger revision;
        public final Binding binding;
        Snapshot(boolean migrated, BigInteger revision, Binding binding) {
            migrationComplete = migrated; this.revision = revision; this.binding = binding;
        }
        public Map<String, Object> toBridge() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("migrationComplete", migrationComplete); result.put("revision", revision.toString());
            result.put("binding", binding == null ? null : binding.toBridge()); return Collections.unmodifiableMap(result);
        }
    }
    public static final class StaleRevision extends IllegalStateException {
        StaleRevision() { super("Veraltete Bindungsrevision"); }
    }
    private static final int MAGIC = 0x424c4231;
    static final int MAX_BYTES = 512;
    static final BigInteger MAX_REVISION = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
    private final Storage storage;
    public NativeBindingRepository(Storage storage) { this.storage = Objects.requireNonNull(storage); }
    public synchronized Snapshot read() throws IOException {
        byte[] bytes = storage.read();
        return bytes == null ? new Snapshot(false, BigInteger.ZERO, null) : decode(bytes);
    }
    public synchronized Snapshot migrate(Binding legacy) throws IOException {
        Snapshot old = read();
        return old.migrationComplete ? old : save(old, legacy);
    }
    public synchronized Snapshot requireMigrated() throws IOException {
        Snapshot value = read();
        if (!value.migrationComplete) throw new IllegalStateException("Bindung muss zuerst explizit migriert werden");
        return value;
    }
    /** Called by the service only after the core's correlated STATUS + Control completion. */
    synchronized Snapshot afterHandshake(BigInteger revision, String uuid, String address) throws IOException {
        Snapshot old = requireMigrated(); checkRevision(old, revision);
        Binding next = new Binding(uuid, address, true);
        if (old.binding != null && !old.binding.deviceId.equals(next.deviceId)) throw new IllegalStateException("BLE binding UUID mismatch");
        return same(old.binding, next) ? old : save(old, next);
    }
    public synchronized Snapshot disableConnection() throws IOException {
        Snapshot old = requireMigrated();
        if (old.binding == null || !old.binding.connectionEnabled) return old;
        return save(old, new Binding(old.binding.deviceId, old.binding.bleAddress, false));
    }
    public synchronized Snapshot forget(BigInteger revision) throws IOException {
        Snapshot old = read(); checkRevision(old, revision);
        // Persist the tombstone even if there was never a sensor. Never delete this file.
        return old.migrationComplete && old.binding == null ? old : save(old, null);
    }
    public static BigInteger revision(String value) {
        if (value == null || !value.matches("0|[1-9][0-9]{0,19}")) throw new IllegalArgumentException("Ungültige Bindungsrevision");
        BigInteger result = new BigInteger(value);
        if (result.compareTo(MAX_REVISION) > 0) throw new IllegalArgumentException("Bindungsrevision außerhalb uint64");
        return result;
    }
    private static void checkRevision(Snapshot old, BigInteger expected) {
        if (!old.revision.equals(expected)) throw new StaleRevision();
    }
    private static boolean same(Binding a, Binding b) {
        return a == null ? b == null : b != null && a.deviceId.equals(b.deviceId) && a.bleAddress.equals(b.bleAddress) && a.connectionEnabled == b.connectionEnabled;
    }
    private Snapshot save(Snapshot old, Binding binding) throws IOException {
        if (old.revision.equals(MAX_REVISION)) throw new IOException("Bindungsrevision ausgeschöpft");
        Snapshot next = new Snapshot(true, old.revision.add(BigInteger.ONE), binding);
        byte[] encoded = encode(next); storage.write(encoded);
        // A success reply is a durable, read-back-confirmed snapshot, never an optimistic cache.
        if (!Arrays.equals(encoded, storage.read())) throw new IOException("Bindung konnte nicht bestätigt werden");
        return next;
    }
    static byte[] encode(Snapshot value) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
        out.writeInt(MAGIC); out.writeBoolean(value.migrationComplete); out.writeUTF(value.revision.toString());
        out.writeBoolean(value.binding != null);
        if (value.binding != null) {
            out.writeUTF(value.binding.deviceId); out.writeUTF(value.binding.bleAddress); out.writeBoolean(value.binding.connectionEnabled);
        }
        CRC32 crc = new CRC32(); crc.update(bytes.toByteArray()); out.writeInt((int) crc.getValue()); return bytes.toByteArray();
    }
    static Snapshot decode(byte[] bytes) throws IOException {
        if (bytes.length < 10 || bytes.length > MAX_BYTES) throw new IOException("Ungültige Bindungsdatei");
        try {
            CRC32 crc = new CRC32(); crc.update(bytes, 0, bytes.length - 4);
            DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes));
            if (in.readInt() != MAGIC || !in.readBoolean()) throw new IOException("Unbekannte Bindungsversion / Migration");
            BigInteger revision = revision(in.readUTF());
            if (revision.signum() == 0) throw new IOException("Ungültige persistierte Revision");
            Binding binding = in.readBoolean() ? new Binding(in.readUTF(), in.readUTF(), in.readBoolean()) : null;
            if (Integer.toUnsignedLong(in.readInt()) != crc.getValue() || in.available() != 0) throw new IOException("Bindungsdatei CRC / Größe ungültig");
            return new Snapshot(true, revision, binding);
        } catch (RuntimeException e) { throw new IOException("Ungültige Bindungsdaten", e); }
    }
}
