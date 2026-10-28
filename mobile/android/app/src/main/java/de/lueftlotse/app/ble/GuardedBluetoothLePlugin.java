package de.lueftlotse.app.ble;

import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Keeps the installed plugin and its listeners/permission launchers; only admission is added. */
@CapacitorPlugin(name = "BluetoothLe", permissions = {
    @Permission(alias = "ACCESS_COARSE_LOCATION", strings = {"android.permission.ACCESS_COARSE_LOCATION"}),
    @Permission(alias = "ACCESS_FINE_LOCATION", strings = {"android.permission.ACCESS_FINE_LOCATION"}),
    @Permission(alias = "BLUETOOTH", strings = {"android.permission.BLUETOOTH"}),
    @Permission(alias = "BLUETOOTH_ADMIN", strings = {"android.permission.BLUETOOTH_ADMIN"}),
    @Permission(alias = "BLUETOOTH_SCAN", strings = {"android.permission.BLUETOOTH_SCAN"}),
    @Permission(alias = "BLUETOOTH_CONNECT", strings = {"android.permission.BLUETOOTH_CONNECT"})
})
public final class GuardedBluetoothLePlugin extends Plugin {
    private PluginHandle delegate;
    private final LegacyBleGate gate = new LegacyBleGate(BleServiceRuntime.OWNERSHIP);
    @Override public void load() {
        delegate = getBridge().getPlugin("BluetoothLe");
        if (delegate == null || delegate.getInstance() instanceof GuardedBluetoothLePlugin) throw new IllegalStateException("Original BluetoothLe plugin missing");
    }
    private void forward(String method, PluginCall call) {
        try { delegate.invoke(method, call); }
        catch (Exception error) { call.reject("BLE-Aufruf fehlgeschlagen", error); }
    }
    @PluginMethod public void connect(PluginCall call) {
        try {
            LegacyBleGate.Attempt attempt = gate.connect(call.getString("deviceId"));
            forward("connect", new ObservedCall(call, () -> gate.connectSettled(attempt), () -> gate.connectSettled(attempt)));
        } catch (RuntimeException e) { call.reject(e.getMessage()); }
    }
    @PluginMethod public void disconnect(PluginCall call) {
        try {
            LegacyBleGate.Attempt attempt = gate.disconnect(call.getString("deviceId"));
            forward("disconnect", new ObservedCall(call, () -> gate.disconnected(attempt), () -> { }));
        } catch (RuntimeException e) { call.reject(e.getMessage()); }
    }
    @Override protected void handleOnDestroy() {
        // Bridge.quitSafely() drains this already posted command after any connect invocation.
        // Only this legacy instance is cleaned; a service-owned lease is never touched.
        getBridge().execute(() -> {
            LegacyBleGate.Attempt attempt = gate.destroy();
            if (attempt == null) return;
            JSObject data = new JSObject(); data.put("deviceId", attempt.address);
            forward("disconnect", new PluginCall(null, "BluetoothLe", "native-cleanup", "disconnect", data) {
                @Override public void resolve() { gate.disconnected(attempt); }
                @Override public void resolve(JSObject result) { gate.disconnected(attempt); }
                @Override public void reject(String message, String code, Exception error, JSObject extra) {
                    // A failed native cleanup keeps the lease reserved. Never guess GATT is closed.
                }
            });
        });
    }
    private static final class ObservedCall extends PluginCall {
        private final PluginCall original;
        private final Runnable success, failure;
        private final AtomicBoolean settled = new AtomicBoolean();
        ObservedCall(PluginCall original, Runnable success, Runnable failure) {
            super(null, original.getPluginId(), original.getCallbackId(), original.getMethodName(), original.getData());
            this.original = original; this.success = success; this.failure = failure;
        }
        private boolean settle(boolean ok) { if (!settled.compareAndSet(false, true)) return false; (ok ? success : failure).run(); return true; }
        @Override public void resolve() { if (settle(true)) original.resolve(); }
        @Override public void resolve(JSObject value) { if (settle(true)) original.resolve(value); }
        @Override public void reject(String message, String code, Exception error, JSObject data) { if (settle(false)) original.reject(message, code, error, data); }
        @Override public void successCallback(PluginResult result) { if (settle(true)) original.successCallback(result); }
        @Override public void errorCallback(String message) { if (settle(false)) original.errorCallback(message); }
    }

    // Explicit forwarding preserves Capacitor method metadata; a JVM test pins parity to the installed plugin.
    @PluginMethod public void initialize(PluginCall c) { forward("initialize", c); }
    @PluginMethod public void isEnabled(PluginCall c) { forward("isEnabled", c); }
    @PluginMethod public void requestEnable(PluginCall c) { forward("requestEnable", c); }
    @PluginMethod public void enable(PluginCall c) { forward("enable", c); }
    @PluginMethod public void disable(PluginCall c) { forward("disable", c); }
    @PluginMethod public void startEnabledNotifications(PluginCall c) { forward("startEnabledNotifications", c); }
    @PluginMethod public void stopEnabledNotifications(PluginCall c) { forward("stopEnabledNotifications", c); }
    @PluginMethod public void isLocationEnabled(PluginCall c) { forward("isLocationEnabled", c); }
    @PluginMethod public void openLocationSettings(PluginCall c) { forward("openLocationSettings", c); }
    @PluginMethod public void openBluetoothSettings(PluginCall c) { forward("openBluetoothSettings", c); }
    @PluginMethod public void openAppSettings(PluginCall c) { forward("openAppSettings", c); }
    @PluginMethod public void setDisplayStrings(PluginCall c) { forward("setDisplayStrings", c); }
    @PluginMethod public void requestDevice(PluginCall c) { forward("requestDevice", c); }
    @PluginMethod public void requestLEScan(PluginCall c) { forward("requestLEScan", c); }
    @PluginMethod public void stopLEScan(PluginCall c) { forward("stopLEScan", c); }
    @PluginMethod public void getDevices(PluginCall c) { forward("getDevices", c); }
    @PluginMethod public void getConnectedDevices(PluginCall c) { forward("getConnectedDevices", c); }
    @PluginMethod public void getBondedDevices(PluginCall c) { forward("getBondedDevices", c); }
    @PluginMethod public void createBond(PluginCall c) { forward("createBond", c); }
    @PluginMethod public void isBonded(PluginCall c) { forward("isBonded", c); }
    @PluginMethod public void getServices(PluginCall c) { forward("getServices", c); }
    @PluginMethod public void discoverServices(PluginCall c) { forward("discoverServices", c); }
    @PluginMethod public void getMtu(PluginCall c) { forward("getMtu", c); }
    @PluginMethod public void requestConnectionPriority(PluginCall c) { forward("requestConnectionPriority", c); }
    @PluginMethod public void readRssi(PluginCall c) { forward("readRssi", c); }
    @PluginMethod public void read(PluginCall c) { forward("read", c); }
    @PluginMethod public void write(PluginCall c) { forward("write", c); }
    @PluginMethod public void writeWithoutResponse(PluginCall c) { forward("writeWithoutResponse", c); }
    @PluginMethod public void readDescriptor(PluginCall c) { forward("readDescriptor", c); }
    @PluginMethod public void writeDescriptor(PluginCall c) { forward("writeDescriptor", c); }
    @PluginMethod public void startNotifications(PluginCall c) { forward("startNotifications", c); }
    @PluginMethod public void stopNotifications(PluginCall c) { forward("stopNotifications", c); }
    @Override @PluginMethod(returnType = PluginMethod.RETURN_NONE) public void addListener(PluginCall c) { forward("addListener", c); }
    @Override @PluginMethod(returnType = PluginMethod.RETURN_NONE) public void removeListener(PluginCall c) { forward("removeListener", c); }
    @Override @PluginMethod public void removeAllListeners(PluginCall c) { forward("removeAllListeners", c); }
    @Override @PluginMethod public void checkPermissions(PluginCall c) { forward("checkPermissions", c); }
    @Override @PluginMethod public void requestPermissions(PluginCall c) { forward("requestPermissions", c); }
}
