package de.lueftlotse.app.ble;

import android.content.Context;
import android.system.*;
import java.io.*;

/** One file in noBackupFilesDir. rename + file/directory fsync, with explicit IO failures. */
final class AndroidBindingStorage implements NativeBindingRepository.Storage {
    private final File directory, file, temporary;
    AndroidBindingStorage(Context context) {
        directory = context.getApplicationContext().getNoBackupFilesDir();
        if (directory == null) throw new IllegalStateException("Bindungsspeicher nicht verfügbar");
        file = new File(directory, "ble-binding-v1.bin"); temporary = new File(directory, "ble-binding-v1.tmp");
    }
    public byte[] read() throws IOException {
        try { Os.stat(file.getPath()); }
        catch (ErrnoException e) { if (e.errno == OsConstants.ENOENT) return null; throw new IOException("Bindung nicht lesbar", e); }
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[128]; int length;
            while ((length = input.read(buffer)) != -1) {
                if (bytes.size() + length > NativeBindingRepository.MAX_BYTES) throw new IOException("Bindungsdatei zu groß");
                bytes.write(buffer, 0, length);
            }
            // Reconfirm a rename whose previous caller might have lost the fsync acknowledgement.
            syncDirectory(); return bytes.toByteArray();
        }
    }
    public void write(byte[] value) throws IOException {
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(value); output.getFD().sync();
        }
        try {
            Os.rename(temporary.getPath(), file.getPath());
        } catch (ErrnoException e) { throw new IOException("Bindung nicht sicher gespeichert", e); }
        syncDirectory();
        // An interrupted .tmp is never considered committed and is overwritten on retry.
    }
    private void syncDirectory() throws IOException {
        try {
            FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
            try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
        } catch (ErrnoException e) { throw new IOException("Bindungsverzeichnis nicht bestätigt", e); }
    }
}
