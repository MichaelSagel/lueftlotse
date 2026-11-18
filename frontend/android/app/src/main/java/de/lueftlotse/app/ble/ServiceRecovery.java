package de.lueftlotse.app.ble;

import java.io.IOException;

/** Called only on the native command queue after system recreation, without UI migration. */
final class ServiceRecovery {
    static boolean requested(boolean hasIntent, boolean startAction, BleServiceState state) {
        return !hasIntent || (startAction && state.current() == null);
    }

    static BleServiceState.Run reserve(
            NativeBindingRepository repository,
            BleServiceState state,
            boolean permitted
    ) throws IOException {
        if (state.active()) {
            return null;
        }
        return state.reserveSystemRecovery(repository.read(), permitted);
    }
}
