package de.lueftlotse.app.ble;

import android.os.Build;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.*;
import org.json.JSONObject;

/** Explicit local bridge. No migration/start is invoked by application startup. */
@CapacitorPlugin(name = "BleService", permissions = {
    @Permission(alias = "bleConnect", strings = {"android.permission.BLUETOOTH_CONNECT"}),
    @Permission(alias = "notifications", strings = {"android.permission.POST_NOTIFICATIONS"})
})
public final class BleServicePlugin extends Plugin {
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
