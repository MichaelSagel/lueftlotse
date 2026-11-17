package de.lueftlotse.app.ble;

import java.util.*;
import java.util.function.Consumer;

/** Native command-queue coordinator. A scan, timer or GATT attempt is exclusive. */
final class ServiceDiscovery {
    static final long SCAN_MS = 8000;
    interface Timer { void cancel(); }
    interface Port {
        Timer schedule(Runnable action, long delay);
        void scan(Consumer<Candidate> found, Consumer<String> failed);
        void stopScan();
        boolean enabled();
        void connect(String address, String expectedDeviceId);
        void state(String mode, List<Candidate> candidates);
        void terminal(String error);
    }
    static final class Candidate {
        final String address, name;
        Candidate(String address, String name) {
            this.address = address;
            this.name = name == null || name.trim().isEmpty() ? "Lüftlotse" : name.substring(0, Math.min(name.length(), 80));
        }
        Map<String, Object> toBridge() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("address", address);
            value.put("name", name);
            return value;
        }
    }
    private final Port port;
    private final Map<String, Candidate> found = new LinkedHashMap<>();
    private final Set<String> rejected = new HashSet<>();
    private final Deque<Candidate> pending = new ArrayDeque<>();
    private String expected, preferred, current;
    private Timer timer;
    private boolean cancelled, scanning, attempting, choosing;
    private long epoch, delay = 1000;

    ServiceDiscovery(Port port, NativeBindingRepository.Binding saved) {
        this.port = port;
        if (saved != null) {
            expected = saved.deviceId;
            preferred = saved.bleAddress;
        }
    }
    void start() {
        if (preferred == null) {
            search();
        }
        else {
            connect(new Candidate(preferred, "Lüftlotse"));
        }
    }
    String expectedDeviceId() { return expected; }
    void rejectCurrent() {
        if (current != null) {
            rejected.add(current);
        }
    }
    private void connect(Candidate candidate) {
        if (cancelled || attempting || scanning) {
            return;
        }
        if (!port.enabled()) {
            fail("Verbindungsabsicht oder Berechtigung geändert");
            return;
        }
        choosing = false;
        current = candidate.address;
        attempting = true;
        port.state("connecting", Collections.emptyList());
        port.connect(current, expected);
    }
    void ready(NativeBindingRepository.Binding saved) {
        if (cancelled || !attempting) {
            return;
        }
        expected = saved.deviceId;
        preferred = saved.bleAddress;
        attempting = false;
        pending.clear();
        delay = 1000;
        port.state(null, Collections.emptyList());
    }
    void closed(boolean clean, boolean identityRejected) {
        if (cancelled) {
            return;
        }
        attempting = false;
        if (!clean) {
            fail("GATT cleanup uncertain");
            return;
        }
        if (identityRejected && current != null) {
            rejected.add(current);
        }
        if (!pending.isEmpty()) {
            connect(pending.removeFirst());
            return;
        }
        waitForSearch();
    }
    private void waitForSearch() {
        if (cancelled) {
            return;
        }
        port.state("searching", Collections.emptyList());
        long ticket = ++epoch;
        long pause = delay;
        delay = Math.min(30000, delay * 2);
        timer = port.schedule(() -> {
            if (cancelled || ticket != epoch) {
                return;
            }
            timer = null;
            search();
        }, pause);
    }
    private void search() {
        if (cancelled || attempting || scanning) {
            return;
        }
        if (!port.enabled()) {
            fail("Verbindungsabsicht oder Berechtigung geändert");
            return;
        }
        found.clear();
        pending.clear();
        choosing = false;
        scanning = true;
        port.state("searching", Collections.emptyList());
        long ticket = ++epoch;
        try {
            port.scan(candidate -> {
                if (!cancelled && scanning && ticket == epoch && !rejected.contains(candidate.address)) {
                    found.put(candidate.address, candidate);
                }
            }, error -> {
                if (!cancelled && scanning && ticket == epoch) {
                    finishScan();
                }
            });
            if (scanning && !cancelled && ticket == epoch) {
                timer = port.schedule(() -> {
                    if (!cancelled && ticket == epoch) {
                        finishScan();
                    }
                }, SCAN_MS);
            }
        } catch (RuntimeException error) {
            fail("Suche fehlgeschlagen: " + error);
        }
    }
    private void finishScan() {
        if (!scanning || cancelled) {
            return;
        }
        try {
            port.stopScan();
        } catch (RuntimeException error) {
            fail("Suchstopp nicht bestätigt: " + error);
            return;
        }
        scanning = false;
        if (timer != null) {
            timer.cancel();
        }
        timer = null;
        epoch++;
        if (found.isEmpty()) {
            waitForSearch();
        } else if (expected == null && found.size() > 1) {
            choosing = true;
            port.state("choice", new ArrayList<>(found.values()));
        } else {
            if (preferred != null && found.containsKey(preferred)) {
                pending.add(found.remove(preferred));
            }
            pending.addAll(found.values());
            connect(pending.removeFirst());
        }
    }
    void choose(String address) {
        if (cancelled || !choosing || !found.containsKey(address) || expected != null) {
            throw new IllegalStateException("Sensor-Auswahl ist nicht mehr aktuell");
        }
        connect(found.get(address));
    }
    private void fail(String error) {
        try { cancel(); }
        catch (RuntimeException cleanup) { error += "; " + cleanup; }
        port.terminal(error);
    }
    void cancel() {
        cancelled = true;
        epoch++;
        if (timer != null) {
            timer.cancel();
        }
        timer = null;
        pending.clear();
        choosing = false;
        if (scanning) {
            port.stopScan();
            scanning = false;
        }
    }
}
