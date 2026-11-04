package de.lueftlotse.ble.transport;

/** Narrow fakeable boundary. One callback object and one Link per connect attempt. */
public interface GattBoundary {
    int SUCCESS = 0, DISCONNECTED = 0, CONNECTED = 2;
    Link connect(String address, Callbacks callbacks);

    interface Link {
        boolean discover();
        /** Require the exact service, Info READ, Control WRITE, Events NOTIFY and Events CCCD. */
        boolean validateProfile();
        boolean readInfo();
        boolean enableLocalNotifications();
        boolean writeNotificationCccd();
        /** Must use WRITE_TYPE_DEFAULT, never WRITE_TYPE_NO_RESPONSE. */
        boolean writeControl(byte[] value, String token);
        void disconnect();
        void close();
    }

    interface Callbacks {
        void connection(int status, int newState);
        void discovered(int status);
        void info(int status, byte[] value);
        void subscribed(int status);
        void written(String token, int status);
        void events(byte[] value);
        void failure(String reason);
    }
}
