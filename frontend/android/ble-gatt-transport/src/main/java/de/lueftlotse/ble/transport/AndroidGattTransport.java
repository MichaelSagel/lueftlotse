package de.lueftlotse.ble.transport;

import android.bluetooth.BluetoothAdapter;
import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import java.util.concurrent.RejectedExecutionException;

/** Opt-in factory only; no application/Activity/plugin/service registration. */
public final class AndroidGattTransport {
    private AndroidGattTransport() { }
    public static GattTransport create(Context context, BluetoothAdapter adapter, GattTransport.Listener listener) {
        if (context == null || adapter == null || listener == null) throw new IllegalArgumentException("Missing Android transport arguments");
        AndroidLoop loop = new AndroidLoop();
        return new GattTransport(new AndroidGattBoundary(context.getApplicationContext(), adapter, loop), loop, listener);
    }
    private static final class AndroidLoop implements SerialLoop {
        private final HandlerThread thread = new HandlerThread("LueftlotseGatt");
        private final Handler handler;
        AndroidLoop() { thread.start(); handler = new Handler(thread.getLooper()); }
        public void execute(Runnable task) { if (!handler.post(task)) throw new RejectedExecutionException("GATT loop is closed"); }
        public Timer schedule(Runnable task, long delayMs) {
            if (!handler.postDelayed(task, delayMs)) throw new RejectedExecutionException("GATT loop is closed");
            return () -> handler.removeCallbacks(task);
        }
        public long now() { return SystemClock.elapsedRealtime(); }
        public boolean isOnLoop() { return Looper.myLooper() == thread.getLooper(); }
        public void shutdown() { thread.quitSafely(); }
    }
}
