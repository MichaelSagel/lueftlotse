package de.lueftlotse.app.ble;

import android.os.Build;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.*;
import org.json.JSONObject;
import de.lueftlotse.ble.Codec;
import de.lueftlotse.ble.UInt64;
import java.util.concurrent.CompletionStage;

/** Explicit local bridge. No migration/start is invoked by application startup. */
@CapacitorPlugin(name = "BleService", permissions = {
    @Permission(alias = "bleConnect", strings = {"android.permission.BLUETOOTH_CONNECT"}),
    @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"})
})
public final class BleServicePlugin extends Plugin {
    private volatile String journalOwner = UUID.randomUUID().toString();
    private boolean visible() { return getActivity() != null && getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED); }
    private void resolveState(PluginCall call) {
        try {
            JSObject result = JSObject.fromJSONObject(new JSONObject(BleServiceRuntime.snapshot()));
            result.put("permissionsGranted", BleServiceRuntime.permitted(getContext())); call.resolve(result);
        } catch (Exception error) { call.reject("Dienststatus nicht verfügbar", error); }
    }
    @PluginMethod public void start(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            try {
                BleServiceRuntime.start(getContext().getApplicationContext(), visible(), call.getString("bleAddress"), call.getString("expectedDeviceId"));
                resolveState(call);
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public void disconnect(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            String id = call.getString("runId");
            // A mandatory run token prevents a stale page or notification stopping a later connection.
            if (id == null) { call.reject("runId fehlt"); return; }
            try { BleServiceRuntime.bindingActions(getContext()).disconnect(id, "Vom Benutzer getrennt"); resolveState(call); }
            catch (Exception error) { call.reject("Verbindung geschlossen; Verbindungsabsicht nicht gespeichert", error); }
        });
    }
    @PluginMethod public void getState(PluginCall call) { BleServiceRuntime.MAIN.post(() -> resolveState(call)); }
    /** Cancels transport work without changing the durable user connection intention. */
    @PluginMethod public void closeSession(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            String run = call.getString("runId");
            if (run == null) { call.reject("runId fehlt"); return; }
            BleServiceRuntime.disconnect(run, "BLE operation cancelled"); resolveState(call);
        });
    }
    private ServiceJournal journal(String run) {
        if (BleServiceRuntime.host == null) throw new IllegalStateException("Native service unavailable");
        return BleServiceRuntime.host.journal(run);
    }
    private ServiceJournal.Token journalToken(PluginCall call) throws Exception {
        JSObject token = call.getObject("token");
        if (token == null) throw new IllegalArgumentException("token fehlt");
        return new ServiceJournal.Token(token.getString("runId"), token.getString("generation"), token.getString("clientId"), token.getString("leaseId"));
    }
    private Codec.Message journalAck(PluginCall call) throws Exception {
        JSObject ack = call.getObject("ack");
        if (ack == null || !(ack.opt("count") instanceof Integer)) throw new IllegalArgumentException("ACK fehlt/ungültig");
        String digest = ack.getString("digest");
        if (digest == null || !digest.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid digest");
        byte[] bytes = new byte[32]; for (int i = 0; i < 32; i++) bytes[i] = (byte) Integer.parseInt(digest.substring(i * 2, i * 2 + 2), 16);
        return Codec.message(4, "batchId", ack.getString("batchId"), "throughSequence", UInt64.fromDecimal(ack.getString("throughSequence")), "count", ack.getInt("count"), "digest", bytes);
    }
    private interface JournalCall { CompletionStage<Map<String, Object>> run(String owner) throws Exception; }
    private void journalCall(PluginCall call, JournalCall action) {
        String owner = journalOwner;
        BleServiceRuntime.MAIN.post(() -> {
            try {
                if (!owner.equals(journalOwner) || !visible()) throw new IllegalStateException("WebView unavailable");
                action.run(owner).whenComplete((value, error) -> BleServiceRuntime.MAIN.post(() -> {
                    if (error != null) { call.reject("Journal operation failed: " + error.getMessage()); return; }
                    if (!owner.equals(journalOwner) || !visible()) { call.reject("Journal client revoked"); return; }
                    try { call.resolve(JSObject.fromJSONObject(new JSONObject(value))); }
                    catch (Exception failure) { call.reject("Invalid journal result", failure); }
                }));
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public void journalAcquire(PluginCall call) {
        journalCall(call, owner -> journal(call.getString("runId")).acquire(owner, event -> {
            if (!owner.equals(journalOwner)) return;
            try { notifyListeners("journalEvent", JSObject.fromJSONObject(new JSONObject(event)), false); }
            catch (Exception error) { throw new IllegalStateException(error); }
        }));
    }
    @PluginMethod public void journalStatus(PluginCall call) {
        journalCall(call, owner -> { ServiceJournal.Token token = journalToken(call); return journal(token.runId).status(owner, token); });
    }
    @PluginMethod public void journalFetch(PluginCall call) {
        journalCall(call, owner -> {
            ServiceJournal.Token token = journalToken(call);
            if (!(call.getData().opt("limit") instanceof Integer)) throw new IllegalArgumentException("Invalid FETCH limit");
            return journal(token.runId).fetch(owner, token, call.getString("operationId"), call.getString("afterSequence"), call.getInt("limit"));
        });
    }
    @PluginMethod public void journalBeginCommit(PluginCall call) {
        journalCall(call, owner -> { ServiceJournal.Token token = journalToken(call); return journal(token.runId).beginCommit(owner, token, call.getString("ticketId"), journalAck(call)); });
    }
    @PluginMethod public void journalCommitted(PluginCall call) {
        journalCall(call, owner -> {
            ServiceJournal.Token token = journalToken(call);
            return journal(token.runId).committed(owner, token, call.getString("ticketId"), call.getString("commitToken"),
                Boolean.TRUE.equals(call.getData().opt("committed")), journalAck(call));
        });
    }
    @PluginMethod public void journalHeartbeat(PluginCall call) {
        journalCall(call, owner -> {
            ServiceJournal.Token token = journalToken(call); journal(token.runId).heartbeat(owner, token);
            return java.util.concurrent.CompletableFuture.completedFuture(Collections.emptyMap());
        });
    }
    @PluginMethod public void journalRevoke(PluginCall call) {
        String owner = journalOwner;
        BleServiceRuntime.MAIN.post(() -> {
            try {
                ServiceJournal.Token token = journalToken(call);
                if (BleServiceRuntime.STATE.matches(token.runId)) journal(token.runId).revoke(owner, token);
                call.resolve();
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }
    private void revokeJournalOwner() {
        String owner = journalOwner; journalOwner = UUID.randomUUID().toString();
        BleServiceRuntime.MAIN.post(() -> { if (BleServiceRuntime.host != null) BleServiceRuntime.host.revokeJournalOwner(owner); });
    }
    @Override protected void handleOnPause() { revokeJournalOwner(); }
    @Override protected void handleOnDestroy() { revokeJournalOwner(); }
    private void resolveBinding(PluginCall call, NativeBindingRepository.Snapshot value) {
        try { call.resolve(JSObject.fromJSONObject(new JSONObject(value.toBridge()))); }
        catch (Exception error) { call.reject("Bindungsstatus nicht verfügbar", error); }
    }
    @PluginMethod public void getBinding(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            try { resolveBinding(call, BleServiceRuntime.bindings(getContext()).read()); }
            catch (Exception error) { call.reject("Bindung konnte nicht gelesen werden", error); }
        });
    }
    @PluginMethod public void migrateBinding(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            BleOwnership.Lease lease = null;
            try {
                NativeBindingRepository repository = BleServiceRuntime.bindings(getContext());
                NativeBindingRepository.Snapshot saved = repository.read();
                if (saved.migrationComplete) { resolveBinding(call, saved); return; }
                lease = BleServiceRuntime.OWNERSHIP.acquire(BleOwnership.Owner.SERVICE);
                if (!call.getData().has("binding")) throw new IllegalArgumentException("binding fehlt (null für leere Bindung)");
                NativeBindingRepository.Binding binding = null;
                if (!call.getData().isNull("binding")) {
                    JSObject input = call.getObject("binding");
                    if (input == null || !Integer.valueOf(1).equals(input.opt("version")) || !(input.opt("connectionEnabled") instanceof Boolean)) throw new IllegalArgumentException("Ungültige alte Bindung");
                    binding = new NativeBindingRepository.Binding(input.getString("deviceId"), input.getString("bleAddress"), input.getBool("connectionEnabled"));
                }
                resolveBinding(call, repository.migrate(binding));
            } catch (Exception error) { call.reject("Bindung nicht migriert / bestätigt", error); }
            finally { if (lease != null) BleServiceRuntime.OWNERSHIP.release(lease); }
        });
    }
    @PluginMethod public void forgetBinding(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            BleOwnership.Lease lease = null;
            try {
                // A service run already owns the slot; otherwise exclude a simultaneous legacy connect.
                if (!BleServiceRuntime.STATE.active()) lease = BleServiceRuntime.OWNERSHIP.acquire(BleOwnership.Owner.SERVICE);
                resolveBinding(call, BleServiceRuntime.bindingActions(getContext()).forget(NativeBindingRepository.revision(call.getString("revision"))));
            } catch (Exception error) { call.reject("Gerät konnte nicht vergessen werden", error); }
            finally { if (lease != null) BleServiceRuntime.OWNERSHIP.release(lease); }
        });
    }
    @Override @PluginMethod public void requestPermissions(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            if (!visible()) { call.reject("Berechtigungen nur aus sichtbarer Activity anfordern"); return; }
            List<String> aliases = new ArrayList<>();
            if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bleConnect") != PermissionState.GRANTED) aliases.add("bleConnect");
            if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) aliases.add("notifications");
            if (aliases.isEmpty()) resolveState(call);
            else requestPermissionForAliases(aliases.toArray(new String[0]), call, "permissionsResult");
        });
    }
    @PermissionCallback private void permissionsResult(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> resolveState(call)); // Granting permission never starts the service.
    }
}
