package de.lueftlotse.app.ble;

/** Pure policy; all grants are rechecked by the Service before constructing a transport. */
public final class ServicePermissionPolicy {
    private ServicePermissionPolicy() { }
    public static boolean canConnect(int sdk, boolean legacyBluetooth, boolean connect, boolean foreground,
            boolean connectedDevice) {
        return (sdk < 31 ? legacyBluetooth : connect) && (sdk < 28 || foreground)
                && (sdk < 34 || connectedDevice);
    }
    public static boolean canNotify(int sdk, boolean postNotifications, boolean notificationsVisible) {
        return (sdk < 33 || postNotifications) && notificationsVisible;
    }
}
