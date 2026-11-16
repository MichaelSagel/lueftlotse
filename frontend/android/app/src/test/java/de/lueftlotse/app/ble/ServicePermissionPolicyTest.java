package de.lueftlotse.app.ble;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServicePermissionPolicyTest {
    @Test public void api24UsesLegacyBluetoothWithoutNotificationGating() {
        assertTrue(ServicePermissionPolicy.canConnect(24, true, false, false, false));
        assertFalse(ServicePermissionPolicy.canConnect(24, false, true, true, true));
    }
    @Test public void api31RequiresConnectAndForeground() {
        assertTrue(ServicePermissionPolicy.canConnect(31, false, true, true, false));
        assertFalse(ServicePermissionPolicy.canConnect(31, true, false, true, true));
        assertFalse(ServicePermissionPolicy.canConnect(31, true, true, false, true));
    }
    @Test public void deniedNotificationGrantDoesNotBlockBluetoothOrForegroundService() {
        assertTrue(ServicePermissionPolicy.canConnect(33, false, true, true, false));
        assertFalse(ServicePermissionPolicy.canNotify(33, false, true));
        assertTrue(ServicePermissionPolicy.canNotify(33, true, true));
    }
    @Test public void disabledChannelDoesNotBlockConnectedDeviceService() {
        assertTrue(ServicePermissionPolicy.canConnect(36, false, true, true, true));
        assertFalse(ServicePermissionPolicy.canNotify(36, true, false));
        assertFalse(ServicePermissionPolicy.canConnect(36, true, true, true, false));
    }
    @Test public void olderAndroidStillRespectsNotificationSettings() {
        assertTrue(ServicePermissionPolicy.canNotify(24, false, true));
        assertFalse(ServicePermissionPolicy.canNotify(24, false, false));
        assertFalse(ServicePermissionPolicy.canNotify(31, true, false));
    }
}
