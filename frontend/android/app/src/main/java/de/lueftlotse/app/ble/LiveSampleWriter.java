package de.lueftlotse.app.ble;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BiConsumer;
import java.util.function.Supplier;

/** One process-owned disk queue. Disconnect never cancels accepted receipts. */
final class LiveSampleWriter {
    interface Store {
        void save(NativeLiveSample sample) throws Exception;
        void close() throws Exception;
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor(task ->
        new Thread(task, "LueftlotseLiveStorage")
    );
    private final Supplier<Store> factory;
    private final BiConsumer<NativeLiveSample, Exception> errors;
    private Store store;

    LiveSampleWriter(Supplier<Store> factory, BiConsumer<NativeLiveSample, Exception> errors) {
        this.factory = factory;
        this.errors = errors;
    }

    void submit(NativeLiveSample sample) {
        executor.execute(() -> {
            try {
                if (store == null) {
                    store = factory.get();
                }
                store.save(sample);
            } catch (Exception error) {
                errors.accept(sample, error);
            }
        });
    }

    CompletableFuture<Void> drain() {
        CompletableFuture<Void> drained = new CompletableFuture<>();
        executor.execute(() -> drained.complete(null));
        return drained;
    }

    /** Graceful shutdown for an explicit owner shutdown/test, never shutdownNow. */
    CompletableFuture<Void> close() {
        CompletableFuture<Void> closed = new CompletableFuture<>();
        executor.execute(() -> {
            try {
                if (store != null) {
                    store.close();
                }
                closed.complete(null);
            } catch (Exception error) {
                closed.completeExceptionally(error);
            }
        });
        executor.shutdown();
        return closed;
    }
}
