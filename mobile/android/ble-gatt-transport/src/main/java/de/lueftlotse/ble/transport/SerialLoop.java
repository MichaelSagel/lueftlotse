package de.lueftlotse.ble.transport;

/** All tasks run serially, never inline. now() is monotonic and includes sleep. */
public interface SerialLoop {
    interface Timer { void cancel(); }
    void execute(Runnable task);
    Timer schedule(Runnable task, long delayMs);
    long now();
    boolean isOnLoop();
    void shutdown();
}
