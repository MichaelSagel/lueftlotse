package de.lueftlotse.app.ble;

import java.util.concurrent.*;
import java.util.function.*;

/** Independent serial queue: notification/latch failures cannot interrupt BLE or SQLite. */
final class Co2AlertMonitor {
    private final ExecutorService queue = Executors.newSingleThreadExecutor(task ->
        new Thread(task, "LueftlotseCo2Alerts")
    );
    private final Supplier<Co2AlertPolicy> factory;
    private final LongSupplier clock;
    private final IntConsumer notify;
    private final BooleanSupplier allowed;
    private final Consumer<Exception> errors;
    private Co2AlertPolicy policy;
    private final java.util.concurrent.atomic.AtomicLong epoch = new java.util.concurrent.atomic.AtomicLong();

    Co2AlertMonitor(Supplier<Co2AlertPolicy> factory, LongSupplier clock,
            BooleanSupplier allowed, IntConsumer notify, Consumer<Exception> errors) {
        this.factory = factory;
        this.clock = clock;
        this.notify = notify;
        this.allowed = allowed;
        this.errors = errors;
    }

    void sample(NativeLiveSample sample, long arrival) {
        long ticket = epoch.get();
        queue.execute(() -> {
            try {
                if (ticket != epoch.get()) {
                    return;
                }
                if (policy == null) {
                    policy = factory.get();
                }
                if (policy.sample(sample, arrival, clock.getAsLong(), allowed.getAsBoolean())) {
                    long now = clock.getAsLong();
                    if (ticket == epoch.get() && now >= arrival && now - arrival < Co2AlertPolicy.FRESH_MS) {
                        notify.accept(sample.ppm);
                    }
                }
            } catch (Exception error) {
                errors.accept(error);
            }
        });
    }

    void interrupted() {
        epoch.incrementAndGet();
        queue.execute(() -> {
            if (policy != null) {
                policy.interrupted();
            }
        });
    }

    CompletableFuture<Void> drain() {
        CompletableFuture<Void> done = new CompletableFuture<>();
        queue.execute(() -> done.complete(null));
        return done;
    }

    CompletableFuture<Void> close() {
        CompletableFuture<Void> done = drain();
        queue.shutdown();
        return done;
    }
}
