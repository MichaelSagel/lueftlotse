package de.lueftlotse.app.ble;

import java.io.IOException;
import java.math.BigInteger;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class NativeBindingRepositoryTest {
    static final String ID = "00112233-4455-4677-8899-aabbccddeeff", OTHER = "11223344-5566-4788-99aa-bbccddeeff00";
    static final String ADDRESS = "AA:BB:CC:DD:EE:01", NEXT = "AA:BB:CC:DD:EE:02";
    static NativeBindingRepository.Binding binding() { return new NativeBindingRepository.Binding(ID, ADDRESS, true); }
    static final class Memory implements NativeBindingRepository.Storage {
        byte[] disk;
        boolean readError, failBeforeWrite, failAfterWrite;
        int reads, failRead = -1, writes;
        final List<String> trace = new ArrayList<>();
        public byte[] read() throws IOException {
            if (++reads == failRead || readError) throw new IOException("read failed");
            return disk == null ? null : disk.clone();
        }
        public void write(byte[] value) throws IOException {
            trace.add("write"); writes++;
            if (failBeforeWrite) throw new IOException("disk full");
            disk = value.clone();
            if (failAfterWrite) throw new IOException("commit acknowledgement lost");
        }
    }
    @Test public void readsDoNotInitializeOrMigrateAnAbsentRecord() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository r = new NativeBindingRepository(disk);
        assertFalse(r.read().migrationComplete); assertEquals(BigInteger.ZERO, r.read().revision); assertNull(disk.disk);
        assertThrows(IllegalStateException.class, r::requireMigrated); assertEquals(0, disk.writes);
    }
    @Test public void migrationSurvivesRestartAndRetryDoesNotReplaceIdentityOrRevision() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository.Snapshot first = new NativeBindingRepository(disk).migrate(binding());
        NativeBindingRepository r = new NativeBindingRepository(disk);
        NativeBindingRepository.Snapshot again = r.migrate(new NativeBindingRepository.Binding(OTHER, NEXT, false));
        assertEquals(first.toBridge(), again.toBridge()); assertEquals(ID, r.read().binding.deviceId); assertEquals(1, disk.writes);
    }
    @Test public void emptyMigrationPersistsATombstoneRatherThanAbsence() throws Exception {
        Memory disk = new Memory(); new NativeBindingRepository(disk).migrate(null);
        NativeBindingRepository.Snapshot saved = new NativeBindingRepository(disk).migrate(binding());
        assertTrue(saved.migrationComplete); assertNull(saved.binding); assertEquals(BigInteger.ONE, saved.revision); assertEquals(1, disk.writes);
    }
    @Test public void interruptionBeforeAtomicReplacementCanRetryTheSameImport() throws Exception {
        Memory disk = new Memory(); disk.failBeforeWrite = true;
        assertThrows(IOException.class, () -> new NativeBindingRepository(disk).migrate(binding()));
        assertNull(disk.disk); disk.failBeforeWrite = false;
        assertEquals(BigInteger.ONE, new NativeBindingRepository(disk).migrate(binding()).revision);
    }
    @Test public void interruptionAfterReplacementDoesNotDuplicateOrUndoMigration() throws Exception {
        Memory disk = new Memory(); disk.failAfterWrite = true;
        assertThrows(IOException.class, () -> new NativeBindingRepository(disk).migrate(binding()));
        disk.failAfterWrite = false; NativeBindingRepository r = new NativeBindingRepository(disk);
        assertTrue(r.read().migrationComplete); assertEquals(ID, r.migrate(null).binding.deviceId); assertEquals(1, disk.writes);
    }
    @Test public void failedReadBackIsNotAcknowledgedButRetryFindsCommittedRecord() throws Exception {
        Memory disk = new Memory(); disk.failRead = 2;
        assertThrows(IOException.class, () -> new NativeBindingRepository(disk).migrate(binding()));
        assertEquals(BigInteger.ONE, new NativeBindingRepository(disk).migrate(null).revision); assertEquals(1, disk.writes);
    }
    @Test public void readErrorsNeverBecomeEmptyMigrationOrOverwriteExistingData() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository r = new NativeBindingRepository(disk); r.migrate(binding());
        byte[] original = disk.disk.clone(); disk.readError = true;
        assertThrows(IOException.class, r::read); assertThrows(IOException.class, () -> r.migrate(null));
        assertThrows(IOException.class, r::disableConnection); assertThrows(IOException.class, () -> r.forget(BigInteger.ONE));
        assertArrayEquals(original, disk.disk); assertEquals(1, disk.writes);
    }
    @Test public void corruptedAndTruncatedFilesAreErrorsNotAbsence() throws Exception {
        Memory disk = new Memory(); new NativeBindingRepository(disk).migrate(binding());
        byte[] valid = disk.disk.clone(); disk.disk[12] ^= 1;
        assertThrows(IOException.class, () -> new NativeBindingRepository(disk).read());
        disk.disk = Arrays.copyOf(valid, valid.length - 1); assertThrows(IOException.class, () -> new NativeBindingRepository(disk).migrate(null));
        disk.disk = new byte[0]; assertThrows(IOException.class, () -> new NativeBindingRepository(disk).read());
    }
    @Test public void forgetPersistsMarkerAndCannotBeUndoneByStaleIndexedDb() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository r = new NativeBindingRepository(disk); r.migrate(binding());
        NativeBindingRepository.Snapshot gone = r.forget(BigInteger.ONE);
        assertTrue(gone.migrationComplete); assertNull(gone.binding); assertEquals("2", gone.toBridge().get("revision"));
        assertNull(new NativeBindingRepository(disk).migrate(binding()).binding);
        assertEquals(gone.toBridge(), r.forget(gone.revision).toBridge()); assertEquals(2, disk.writes);
    }
    @Test public void forgettingBeforeMigrationAlsoPreventsAnOldImport() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository r = new NativeBindingRepository(disk);
        r.forget(BigInteger.ZERO); assertNull(r.migrate(binding()).binding); assertEquals(BigInteger.ONE, r.read().revision);
    }
    @Test public void uuidMismatchAndStaleRevisionNeverChangeIdentityOrAddress() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository r = new NativeBindingRepository(disk); r.migrate(binding());
        assertThrows(IllegalStateException.class, () -> r.afterHandshake(BigInteger.ONE, OTHER, NEXT));
        assertThrows(NativeBindingRepository.StaleRevision.class, () -> r.afterHandshake(BigInteger.ZERO, ID, NEXT));
        assertThrows(NativeBindingRepository.StaleRevision.class, () -> r.forget(BigInteger.ZERO)); assertEquals(1, disk.writes);
        assertEquals(ADDRESS, r.read().binding.bleAddress);
    }
    @Test public void onlyConfirmedHandshakeEnablesIntentAndUpdatesAddress() throws Exception {
        Memory disk = new Memory(); NativeBindingRepository r = new NativeBindingRepository(disk); r.migrate(binding());
        NativeBindingRepository.Snapshot disabled = r.disableConnection(); assertFalse(disabled.binding.connectionEnabled);
        NativeBindingRepository.Snapshot connected = r.afterHandshake(disabled.revision, ID, NEXT);
        assertTrue(connected.binding.connectionEnabled); assertEquals(NEXT, connected.binding.bleAddress);
        r.afterHandshake(connected.revision, ID, NEXT); assertEquals(3, disk.writes);
    }
    @Test public void revisionUsesTheFullUint64RangeAndNeverWraps() throws Exception {
        Memory disk = new Memory(); disk.disk = NativeBindingRepository.encode(new NativeBindingRepository.Snapshot(true, NativeBindingRepository.MAX_REVISION, binding()));
        NativeBindingRepository r = new NativeBindingRepository(disk);
        assertEquals("18446744073709551615", r.read().toBridge().get("revision"));
        assertThrows(IOException.class, r::disableConnection); assertEquals(0, disk.writes);
        for (String value : new String[] {"-1", "01", "1.0", "18446744073709551616"}) assertThrows(IllegalArgumentException.class, () -> NativeBindingRepository.revision(value));
    }
}
