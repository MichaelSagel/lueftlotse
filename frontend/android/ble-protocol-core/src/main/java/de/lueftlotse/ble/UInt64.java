package de.lueftlotse.ble;

import java.math.BigInteger;
import static de.lueftlotse.ble.ProtocolException.require;

/** Never convert a wire uint64 through long, double or a JSON number. */
public final class UInt64 {
    public static final BigInteger MAX = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
    private UInt64() { }

    public static BigInteger checked(BigInteger value) {
        require(value != null && value.signum() >= 0 && value.compareTo(MAX) <= 0, "uint64 overflow");
        return value;
    }

    public static BigInteger fromDecimal(String value) {
        require(value != null && value.matches("0|[1-9][0-9]{0,19}"), "Expected canonical uint64 decimal string");
        return checked(new BigInteger(value));
    }

    public static String toDecimal(BigInteger value) { return checked(value).toString(); }
}
