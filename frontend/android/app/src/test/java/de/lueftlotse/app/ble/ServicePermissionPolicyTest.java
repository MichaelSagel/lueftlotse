package de.lueftlotse.app.ble;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServicePermissionPolicyTest {
    @Test public void api24UsesLegacyBluetoothAndVisibleNotification() {
        assertTrue(ServicePermissionPolicy.canConnect(24, true, false, false, false, false, true));
        assertFalse(ServicePermissionPolicy.canConnect(24, false, true, true, true, true, true));
    }
    @Test public void api31RequiresConnectAndForegroundButNotPostPermission() {
        assertTrue(ServicePermissionPolicy.canConnect(31, false, true, true, false, false, true));
        assertFalse(ServicePermissionPolicy.canConnect(31, true, false, true, true, true, true));
        assertFalse(ServicePermissionPolicy.canConnect(31, true, true, false, true, true, true));
    }
    @Test public void api33RequiresNotificationGrantByProductPolicy() {
        assertFalse(ServicePermissionPolicy.canConnect(33, true, true, true, true, false, true));
        assertTrue(ServicePermissionPolicy.canConnect(33, false, true, true, false, true, true));
    }
    @Test public void target36RequiresConnectedDevicePermissionAndEnabledChannel() {
        assertTrue(ServicePermissionPolicy.canConnect(36, false, true, true, true, true, true));
        assertFalse(ServicePermissionPolicy.canConnect(36, true, true, true, false, true, true));
        assertFalse(ServicePermissionPolicy.canConnect(36, true, true, true, true, true, false));
    }
}
