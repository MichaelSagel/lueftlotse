package de.lueftlotse.ble.transport;

import android.annotation.SuppressLint;
import android.bluetooth.*;
import android.content.Context;
import android.os.Build;
import de.lueftlotse.ble.Codec;
import java.util.UUID;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** The only class touching BluetoothGatt. Permission grants belong to the future caller. */
@SuppressLint("MissingPermission")
final class AndroidGattBoundary implements GattBoundary {
    private static final UUID SERVICE = UUID.fromString(Codec.SERVICE), INFO = UUID.fromString(Codec.INFO),
            CONTROL = UUID.fromString(Codec.CONTROL), EVENTS = UUID.fromString(Codec.EVENTS),
            CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private final Context context;
    private final BluetoothAdapter adapter;
    private final SerialLoop loop;
    AndroidGattBoundary(Context context, BluetoothAdapter adapter, SerialLoop loop) { this.context = context; this.adapter = adapter; this.loop = loop; }

    @Override public Link connect(String address, Callbacks callbacks) {
        requireLoop(); NativeLink link = new NativeLink(callbacks);
        try {
            BluetoothDevice device = adapter.getRemoteDevice(address);
            BluetoothGatt gatt = device.connectGatt(context, false, link.callback, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) { link.close(); return null; }
            if (!link.identify(gatt)) { link.close(); throw new IllegalStateException("connectGatt handle mismatch"); }
            return link;
        } catch (RuntimeException e) { link.close(); throw e; }
    }
    private void requireLoop() { if (!loop.isOnLoop()) throw new IllegalStateException("GATT call outside owner loop"); }
    private static byte[] copy(byte[] value, int max) { return value != null && value.length <= max ? value.clone() : null; }

    private final class NativeLink implements Link {
        private final Callbacks sink;
        private final AtomicBoolean closed = new AtomicBoolean(), disconnected = new AtomicBoolean();
        private final AtomicReference<String> writeToken = new AtomicReference<>();
        private volatile BluetoothGatt gatt;
        private volatile BluetoothGattCharacteristic info, control, events;
        private volatile BluetoothGattDescriptor cccd;
        NativeLink(Callbacks sink) { this.sink = sink; }
        // A callback may arrive before connectGatt returns. It still belongs to this one Link.
        private synchronized boolean identify(BluetoothGatt candidate) {
            if (gatt == null && !closed.get()) gatt = candidate;
            if (candidate != gatt) {
                Runnable cleanup = () -> { try { candidate.close(); } catch (RuntimeException ignored) { } };
                // A handle delivered after disposal still must be closed, even if the owner loop exited.
                try { loop.execute(cleanup); } catch (RejectedExecutionException stopped) { cleanup.run(); }
                sink.failure("Callback from a different BluetoothGatt"); return false;
            }
            return !closed.get();
        }
        private BluetoothGatt current() {
            requireLoop(); if (closed.get() || gatt == null) throw new IllegalStateException("GATT is closed"); return gatt;
        }
        public boolean discover() { return current().discoverServices(); }
        public boolean validateProfile() {
            BluetoothGattService found = null;
            for (BluetoothGattService service : current().getServices()) if (SERVICE.equals(service.getUuid())) {
                if (found != null) return false; found = service;
            }
            if (found == null) return false;
            for (BluetoothGattCharacteristic characteristic : found.getCharacteristics()) {
                UUID uuid = characteristic.getUuid();
                if (INFO.equals(uuid)) { if (info != null) return false; info = characteristic; }
                if (CONTROL.equals(uuid)) { if (control != null) return false; control = characteristic; }
                if (EVENTS.equals(uuid)) { if (events != null) return false; events = characteristic; }
            }
            if (info == null || control == null || events == null ||
                    (info.getProperties() & BluetoothGattCharacteristic.PROPERTY_READ) == 0 ||
                    (control.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0 ||
                    (events.getProperties() & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0) return false;
            for (BluetoothGattDescriptor descriptor : events.getDescriptors()) if (CCCD.equals(descriptor.getUuid())) {
                if (cccd != null) return false; cccd = descriptor;
            }
            return cccd != null;
        }
        public boolean readInfo() { return current().readCharacteristic(info); }
        public boolean enableLocalNotifications() { return current().setCharacteristicNotification(events, true); }
        @SuppressWarnings("deprecation")
        public boolean writeNotificationCccd() {
            BluetoothGatt gatt = current(); byte[] value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE.clone();
            if (Build.VERSION.SDK_INT >= 33) return gatt.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS;
            return cccd.setValue(value) && gatt.writeDescriptor(cccd);
        }
        @SuppressWarnings("deprecation")
        public boolean writeControl(byte[] value, String token) {
            BluetoothGatt gatt = current();
            if (!writeToken.compareAndSet(null, token)) throw new IllegalStateException("Second native write is not allowed");
            byte[] copy = value.clone();
            if (Build.VERSION.SDK_INT >= 33) return gatt.writeCharacteristic(control, copy, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
            control.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            return control.setValue(copy) && gatt.writeCharacteristic(control);
        }
        public void disconnect() {
            requireLoop(); if (!closed.get() && gatt != null && disconnected.compareAndSet(false, true)) gatt.disconnect();
        }
        public void close() {
            requireLoop(); if (closed.compareAndSet(false, true)) { writeToken.set(null); if (gatt != null) gatt.close(); }
        }
        private void read(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status, byte[] value) {
            if (!identify(gatt)) return;
            if (characteristic != info) { sink.failure("Read callback for a different characteristic"); return; }
            sink.info(status, copy(value, 20));
        }
        private void changed(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            if (!identify(gatt)) return;
            if (characteristic != events) { sink.failure("Notification for a different characteristic"); return; }
            sink.events(copy(value, 20));
        }
        final BluetoothGattCallback callback = new BluetoothGattCallback() {
            @Override public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (identify(gatt)) sink.connection(status, newState);
            }
            @Override public void onServicesDiscovered(BluetoothGatt gatt, int status) { if (identify(gatt)) sink.discovered(status); }
            @Override @SuppressWarnings("deprecation")
            public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                if (Build.VERSION.SDK_INT < 33) read(gatt, characteristic, status, characteristic.getValue());
            }
            @Override public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value, int status) {
                read(gatt, characteristic, status, value);
            }
            @Override @SuppressWarnings("deprecation")
            public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
                if (Build.VERSION.SDK_INT < 33) changed(gatt, characteristic, characteristic.getValue());
            }
            @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
                changed(gatt, characteristic, value);
            }
            @Override public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
                if (!identify(gatt)) return;
                if (descriptor != cccd) { sink.failure("Write callback for a different descriptor"); return; }
                sink.subscribed(status);
            }
            @Override public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                if (!identify(gatt)) return;
                if (characteristic != control) { sink.failure("Write callback for a different characteristic"); return; }
                String token = writeToken.getAndSet(null);
                if (token == null) { sink.failure("Unexpected duplicate write callback"); return; }
                sink.written(token, status);
            }
            @Override public void onServiceChanged(BluetoothGatt gatt) { if (identify(gatt)) sink.failure("GATT services changed; rediscovery requires a new connection"); }
        };
    }
}
