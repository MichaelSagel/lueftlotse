package de.lueftlotse.app.ble;

import org.junit.Test;
import static org.junit.Assert.*;

public class DiscoveryPermissionsTest {
    @Test public void modernAndroidUsesNearbyScanWithoutLocation() {
        assertTrue(DiscoveryPermissions.granted(36, true, false, false));
        assertFalse(DiscoveryPermissions.granted(31, false, true, true));
    }
    @Test public void androidTenAndElevenRequireFineAndBackgroundLocation() {
        for (int sdk : new int[]{29, 30}) {
            assertFalse(DiscoveryPermissions.granted(sdk, false, true, false));
            assertFalse(DiscoveryPermissions.granted(sdk, false, false, true));
            assertTrue(DiscoveryPermissions.granted(sdk, false, true, true));
        }
    }
    @Test public void earlierAndroidUsesFineLocation() {
        assertTrue(DiscoveryPermissions.granted(24, false, true, false));
        assertFalse(DiscoveryPermissions.granted(28, true, false, false));
    }
}
