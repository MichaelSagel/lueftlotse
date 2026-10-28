package de.lueftlotse.app.ble;

import android.os.Build;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.*;
import org.json.JSONObject;

/** Explicit local bridge. Angular does not call this plugin yet. */
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
            } catch (RuntimeException error) { call.reject(error.getMessage()); }
        });
    }
    @PluginMethod public void disconnect(PluginCall call) {
        BleServiceRuntime.MAIN.post(() -> {
            String id = call.getString("runId");
            // A mandatory run token prevents a stale page or notification stopping a later connection.
            if (id == null) { call.reject("runId fehlt"); return; }
            BleServiceRuntime.disconnect(id, "Vom Benutzer getrennt"); resolveState(call);
        });
    }
    @PluginMethod public void getState(PluginCall call) { BleServiceRuntime.MAIN.post(() -> resolveState(call)); }
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
