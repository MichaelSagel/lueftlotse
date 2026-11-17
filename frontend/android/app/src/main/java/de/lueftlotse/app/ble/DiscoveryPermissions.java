package de.lueftlotse.app.ble;

/** Older Android requires background location for service-owned Bluetooth discovery. */
final class DiscoveryPermissions {
    static boolean granted(int sdk, boolean scan, boolean fine, boolean background) {
        if (sdk >= 31) {
            return scan;
        }
        return fine && (sdk < 29 || background);
    }
}
