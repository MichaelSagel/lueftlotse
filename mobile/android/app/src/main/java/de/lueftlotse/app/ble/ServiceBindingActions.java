package de.lueftlotse.app.ble;

import de.lueftlotse.ble.Codec;
import java.io.IOException;
import java.math.BigInteger;
import java.util.function.BiConsumer;

/** Serialized by the service command queue; tested without Android or a radio. */
final class ServiceBindingActions {
    private final NativeBindingRepository repository;
    private final BleServiceState state;
    private final BiConsumer<String, String> close;
    ServiceBindingActions(NativeBindingRepository repository, BleServiceState state, BiConsumer<String, String> close) {
        this.repository = repository; this.state = state; this.close = close;
    }
    boolean ready(String runId, Codec.Info info) {
        if (!state.canBecomeReady(runId)) return false;
        BleServiceState.Run run = state.current();
        try {
            if (run.expectedDeviceId != null && !run.expectedDeviceId.equals(info.deviceId)) throw new IllegalStateException("BLE binding UUID mismatch");
            repository.afterHandshake(run.bindingRevision, info.deviceId, run.address);
            state.ready(runId, info); return true;
        } catch (IOException | RuntimeException error) {
            state.bindingError("Bindung nach STATUS nicht gespeichert: " + error.getMessage());
            close.accept(runId, "Bindung konnte nicht bestätigt werden"); return false;
        }
    }
    void disconnect(String runId, String reason) throws IOException {
        BleServiceState.Run run = state.current();
        if (run == null || !run.id.equals(runId)) return;
        try { repository.disableConnection(); state.bindingError(null); }
        catch (IOException | RuntimeException error) {
            state.bindingError("Verbindungsabsicht nicht gespeichert: " + error.getMessage()); throw error;
        } finally { close.accept(runId, reason); }
    }
    NativeBindingRepository.Snapshot forget(BigInteger revision) throws IOException {
        boolean closeSession = true;
        try {
            NativeBindingRepository.Snapshot value = repository.forget(revision); state.bindingError(null); return value;
        } catch (NativeBindingRepository.StaleRevision stale) {
            closeSession = false; throw stale; // An old page cannot stop or forget a newer session.
        } catch (IOException | RuntimeException error) {
            state.bindingError("Gerät nicht vergessen: " + error.getMessage()); throw error;
        } finally {
            BleServiceState.Run run = state.current();
            if (closeSession && run != null) close.accept(run.id, "Gerät vergessen");
        }
    }
}
