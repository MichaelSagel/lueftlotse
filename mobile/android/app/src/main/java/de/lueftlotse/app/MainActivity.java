package de.lueftlotse.app;

import com.getcapacitor.BridgeActivity;
import de.lueftlotse.app.ble.BleServicePlugin;
import de.lueftlotse.app.ble.GuardedBluetoothLePlugin;

public class MainActivity extends BridgeActivity {
    @Override protected void load() {
        // Appended after auto-discovered plugins, before Bridge injects JS or loads the WebView.
        registerPlugin(GuardedBluetoothLePlugin.class);
        registerPlugin(BleServicePlugin.class);
        super.load();
        if (!(getBridge().getPlugin("BluetoothLe").getInstance() instanceof GuardedBluetoothLePlugin)) {
            throw new IllegalStateException("BLE ownership guard was not installed");
        }
    }
}
