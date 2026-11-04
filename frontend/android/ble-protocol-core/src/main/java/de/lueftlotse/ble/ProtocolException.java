package de.lueftlotse.ble;

/** Invalid wire data or an invalid local protocol operation. */
public final class ProtocolException extends IllegalArgumentException {
    public ProtocolException(String message) { super(message); }

    static void require(boolean condition, String message) {
        if (!condition) throw new ProtocolException(message);
    }
}
