package de.lueftlotse.app.ble;

import com.capacitorjs.community.plugins.bluetoothle.BluetoothLe;
import com.capacitorjs.community.plugins.bluetoothle.DeviceScanner;
import com.getcapacitor.PluginCall;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.reflect.Method;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

public class LegacyPluginContractTest {
    private Map<String, String> methods(Class<?> type) {
        Map<String, String> result = new TreeMap<>();
        for (Method method : type.getMethods()) {
            PluginMethod annotation = method.getAnnotation(PluginMethod.class);
            if (annotation != null) result.put(method.getName(), annotation.returnType());
        }
        return result;
    }
    @Test public void guardPreservesEveryInstalledPluginMethodAndReturnType() {
        assertEquals(methods(BluetoothLe.class), methods(GuardedBluetoothLePlugin.class));
        assertEquals("BluetoothLe", GuardedBluetoothLePlugin.class.getAnnotation(CapacitorPlugin.class).name());
    }
    @Test public void guardPreservesPermissionAliases() {
        Map<String, List<String>> expected = new TreeMap<>(), actual = new TreeMap<>();
        for (com.getcapacitor.annotation.Permission p : BluetoothLe.class.getAnnotation(CapacitorPlugin.class).permissions()) expected.put(p.alias(), Arrays.asList(p.strings()));
        for (com.getcapacitor.annotation.Permission p : GuardedBluetoothLePlugin.class.getAnnotation(CapacitorPlugin.class).permissions()) actual.put(p.alias(), Arrays.asList(p.strings()));
        assertEquals(expected, actual);
    }
    @Test public void installedScannerHasThePinnedDirectStopContract() throws Exception {
        assertEquals(DeviceScanner.class, BluetoothLe.class.getDeclaredField("deviceScanner").getType());
        assertEquals(void.class, DeviceScanner.class.getMethod("stopScanning").getReturnType());
    }
    @Test public void everyGattEntryPointRejectsBeforeTheOriginalPluginCanBeInvoked() throws Exception {
        GuardedBluetoothLePlugin guard = new GuardedBluetoothLePlugin();
        for (String method : Arrays.asList("connect", "disconnect", "read", "write", "writeWithoutResponse", "readDescriptor", "writeDescriptor",
                "getServices", "discoverServices", "getMtu", "requestConnectionPriority", "readRssi", "startNotifications", "stopNotifications", "createBond")) {
            assertFalse(GuardedBluetoothLePlugin.scanOnlyMethod(method));
            java.util.concurrent.atomic.AtomicReference<String> rejected = new java.util.concurrent.atomic.AtomicReference<>();
            PluginCall call = new PluginCall(null, "BluetoothLe", "test", method, null) {
                @Override public void reject(String message, String code, Exception error, JSObject data) { rejected.set(message); }
            };
            guard.getClass().getMethod(method, PluginCall.class).invoke(guard, call);
            assertTrue(method, rejected.get().contains("GATT gehört BleService"));
        }
        assertTrue(GuardedBluetoothLePlugin.scanOnlyMethod("requestLEScan"));
        assertTrue(GuardedBluetoothLePlugin.scanOnlyMethod("stopLEScan"));
    }
}
