package de.lueftlotse.app.ble;

import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.util.concurrent.atomic.AtomicBoolean;
import com.capacitorjs.community.plugins.bluetoothle.BluetoothLe;
import com.capacitorjs.community.plugins.bluetoothle.DeviceScanner;
import java.lang.reflect.Field;
import java.util.Arrays;

/** Installed plugin is scan-only. Service is the sole GATT owner, regardless of migration state. */
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
    private ScanGate scans;
    @Override public void load() {
        delegate = getBridge().getPlugin("BluetoothLe");
        if (delegate == null || delegate.getInstance() instanceof GuardedBluetoothLePlugin) throw new IllegalStateException("Original BluetoothLe plugin missing");
        scans = new ScanGate(BleServiceRuntime.OWNERSHIP);
    }
    static boolean scanOnlyMethod(String method) {
        return Arrays.asList("initialize", "isEnabled", "requestLEScan", "stopLEScan", "addListener", "removeListener",
            "removeAllListeners", "checkPermissions", "requestPermissions").contains(method);
    }
    private void forward(String method, PluginCall call) {
        if (!scanOnlyMethod(method)) { call.reject("BluetoothLe ist nur für die Suche verfügbar; GATT gehört BleService"); return; }
        if (Arrays.asList("initialize", "requestPermissions", "requestLEScan").contains(method) &&
            (getActivity() == null || !getActivity().getLifecycle().getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED))) {
            call.reject("Suche und Berechtigungen nur aus sichtbarer Activity"); return;
        }
        try { delegate.invoke(method, call); }
        catch (Exception error) { call.reject("BLE-Aufruf fehlgeschlagen", error); }
    }
    @PluginMethod public void connect(PluginCall call) { forward("connect", call); }
    @PluginMethod public void disconnect(PluginCall call) { forward("disconnect", call); }
    private void stopConfirmed() throws Exception {
        ScanGate.Attempt attempt = scans.current();
        // Installed 8.3.0 stopLEScan swallows IllegalStateException and resolves anyway.
        // Invoke its scanner directly so exceptions retain admission and reject the bridge call.
        // The pinned field/type/public method are checked by the JVM contract test.
        Field field = BluetoothLe.class.getDeclaredField("deviceScanner"); field.setAccessible(true);
        DeviceScanner scanner = (DeviceScanner) field.get(delegate.getInstance());
        if (scanner != null) scanner.stopScanning();
        scans.stopped(attempt);
    }
    @Override protected void handleOnDestroy() {
        scans.destroy();
        getBridge().execute(() -> {
            try { stopConfirmed(); }
            catch (Exception error) { android.util.Log.e("ScanOnlyBLE", "Scan cleanup uncertain; admission remains blocked", error); }
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
    @PluginMethod public void requestLEScan(PluginCall c) {
        try {
            ScanGate.Attempt attempt = scans.begin();
            forward("requestLEScan", new ObservedCall(c, () -> scans.settled(attempt), () -> scans.settled(attempt)));
        } catch (RuntimeException error) { c.reject(error.getMessage(), error); }
    }
    @PluginMethod public void stopLEScan(PluginCall c) {
        try { stopConfirmed(); c.resolve(); }
        catch (Exception error) { c.reject("Suche konnte nicht sicher beendet werden", error); }
    }
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
