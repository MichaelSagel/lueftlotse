package de.lueftlotse.app.ble;

import android.content.Context;
import android.util.AtomicFile;
import de.lueftlotse.ble.Codec;
import java.io.*;

/** Separate per-device episode latch; never modifies measurement/binding files. Queue access only. */
final class AndroidCo2AlertStore implements Co2AlertPolicy.Store {
    private final File directory;

    AndroidCo2AlertStore(Context context) {
        File root = context.getNoBackupFilesDir();
        if (root == null) {
            throw new IllegalStateException("CO2 alert storage unavailable");
        }
        directory = new File(root, "co2-alerts-v1");
    }

    private AtomicFile file(String deviceId) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("CO2 alert directory unavailable");
        }
        return new AtomicFile(new File(directory, Codec.uuid(deviceId) + ".state"));
    }

    public boolean warned(String deviceId) throws IOException {
        AtomicFile file = file(deviceId);
        try (FileInputStream input = file.openRead()) {
            int value = input.read();
            if ((value != 0 && value != 1) || input.read() != -1) {
                throw new IOException("Invalid CO2 alert latch");
            }
            return value == 1;
        } catch (FileNotFoundException error) {
            try {
                android.system.Os.stat(file.getBaseFile().getPath());
            } catch (android.system.ErrnoException failure) {
                if (failure.errno == android.system.OsConstants.ENOENT) {
                    return false;
                }
                throw new IOException("CO2 alert latch inaccessible", failure);
            }
            throw error;
        }
    }

    public void warned(String deviceId, boolean value) throws IOException {
        AtomicFile file = file(deviceId);
        FileOutputStream output = file.startWrite();
        try {
            output.write(value ? 1 : 0);
            output.getFD().sync();
            file.finishWrite(output);
        } catch (IOException | RuntimeException error) {
            file.failWrite(output);
            throw error;
        }
    }
}
