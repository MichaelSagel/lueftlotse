package de.lueftlotse.app.ble;

/** Main-queue retry policy. One timer/attempt, only after a confirmed connection in this service run. */
final class ServiceReconnect {
    static final long INITIAL_DELAY_MS = 1000;
    static final long MAX_DELAY_MS = 30000;

    interface Timer {
        void cancel();
    }

    interface Port {
        Timer schedule(Runnable action, long delayMs);
        NativeBindingRepository.Binding savedBinding() throws Exception;
        boolean permitted();
        void connect(NativeBindingRepository.Binding binding);
        void terminal(String reason);
    }

    private final Port port;
    private NativeBindingRepository.Binding target;
    private Timer timer;
    private boolean cancelled;
    private boolean attempting = true;
    private long epoch;
    private long nextDelay = INITIAL_DELAY_MS;

    ServiceReconnect(Port port) {
        this.port = port;
    }

    boolean ready(NativeBindingRepository.Binding binding) {
        if (cancelled || !attempting || binding == null || !binding.connectionEnabled) {
            return false;
        }
        target = binding;
        epoch++;
        attempting = false;
        nextDelay = INITIAL_DELAY_MS;
        return true;
    }

    boolean unexpectedClose(boolean clean, boolean identityRejected) {
        if (cancelled) {
            return false;
        }
        if (!clean || identityRejected || target == null) {
            cancel();
            return false;
        }
        if (timer != null) {
            return true;
        }
        attempting = false;
        long ticket = ++epoch;
        long delay = nextDelay;
        nextDelay = Math.min(MAX_DELAY_MS, nextDelay * 2);
        timer = port.schedule(() -> {
            if (cancelled || ticket != epoch || attempting) {
                return;
            }
            timer = null;
            try {
                NativeBindingRepository.Binding saved = port.savedBinding();
                if (saved == null || !saved.connectionEnabled || !saved.deviceId.equals(target.deviceId)
                        || !saved.bleAddress.equals(target.bleAddress) || !port.permitted()) {
                    throw new IllegalStateException("Reconnect intention, identity or permission changed");
                }
                attempting = true;
                port.connect(saved);
            } catch (Exception error) {
                cancel();
                port.terminal("Wiederverbinden beendet: " + error);
            }
        }, delay);
        return true;
    }

    void cancel() {
        cancelled = true;
        epoch++;
        if (timer != null) {
            timer.cancel();
            timer = null;
        }
    }
}
