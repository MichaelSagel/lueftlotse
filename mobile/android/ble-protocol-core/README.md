# Standalone Java BLE protocol core

This module implements [BLE protocol v1.0/v1.1](../../../docs/ble-protocol-v1.md)
without Android, GATT, Capacitor, WebView or storage APIs. It is included as a
Gradle project for compilation/tests and is a transitive service dependency.
The running application still uses `BleConnection` behind `BLE_SESSION`.
Binding ownership remains in the existing IndexedDB store. This module itself
does not implement service lifecycle, storage, reconnect or binding migration.

The separate [Android GATT transport](../ble-gatt-transport/README.md) now implements
an opt-in owner around this core, with fake-boundary JVM tests. The explicit
[Android service](../BLE_SERVICE.md) now owns that transport, without switching
Angular to it. This core's wire formats and public session API are unchanged.

The production code has no external dependencies and targets Java 8 bytecode/APIs
with the installed JDK 21. Its Java APIs are available at the application's
Android minSdk 24. JUnit 4 and Gson are test-only dependencies.

## Codec and integer contract

`Codec` handles Info, all Control/Events types in the specification, all three
canonical journal entry types, and the canonical batch SHA-256 digest. It checks
exact sizes, UUID v4/RFC variant, ranges, flags, batch coverage and duplicate
measurement IDs. Info accepts only major 1, minor 0/1 and each version's known
capability mask. GATT UUID constants are unchanged.

`Wire` handles CRC-32/ISO-HDLC and 7..20-byte ATT framing in either direction.
Each assembler owns an 8192-byte consumed-ID bitmap and one 128-byte buffer.
An ID remains consumed after a failed or expired assembly. Assemblers cannot be
reset: create a new one only for a new physical connection. Message IDs are
independent between directions. Control ID 65535 is reserved; Events may use it.

All wire `uint64` values use `BigInteger`, including values above signed `long`.
`UInt64.fromDecimal` accepts only canonical decimal strings in 0..2^64−1.
`Message.toBridge()`, `Entry.toBridge()` and `Batch.toBridge()` expose **every
64-bit integer as a decimal string**, including signed UTC milliseconds.
They never expose uint64 as `long`, `double` or a JSON number. Digests use hex
strings; other numeric fields fit exactly in a JavaScript Number.
`Codec.fromBridge(type, fields)` accepts fields without the top-level `type` key
and rejects numeric uint64/UTC input. Nested entries include their `tag`.
These are plain immutable Java maps, not a registered Capacitor bridge.

`sampleCounter` is the boot-local preview counter. It is independent of journal
`sequence` and never advances the durable cursor.

## Future transport owner contract

`ProtocolSession` is a synchronized, pull-driven state machine. Its injected
clock supplies nonnegative monotonic milliseconds. It creates no worker threads,
timers or callbacks. The future single GATT owner must:

1. Read and validate Info and the expected binding UUID, subscribe to Events,
   and call `open(infoBytes)` only for a **new physical connection**. Capture the
   returned opaque generation in all transport callbacks. The core queues
   GET_STATUS; it becomes READY only after the matching STATUS **and** successful
   completion of every Control write. An unsolicited STATUS cannot finish it.
2. Serialize lifecycle/command work and transport calls on one owner executor.
   Pull `takeWrite(generation)` and perform one write-with-response. For work
   deferred to that executor, recheck `isWriteCurrent(generation, write.token)`
   immediately before the actual GATT call. Report the callback through
   `writeCompleted(generation, token, success)`. A failed or uncertain write
   closes the protocol session. Never retry individual fragments.
3. Feed notifications to `receive(generation, bytes)`, pump `pollEvent()` and
   `pollLiveSample(generation)`, and call `tick(generation)` regularly, including
   when no BLE traffic arrives. A production owner must schedule ticks; these
   tests drive the clock explicitly. Old-generation callbacks are ignored.
4. Act on CLOSED by closing GATT and unregistering callbacks. Protocol CLOSED is
   a disconnect request/state, not a radio operation. Do not call `open` again
   on the same physical connection to reset IDs. Subscription loss also closes
   the session. UI availability/staleness policy and reconnect belong to a later
   integration stage.

The write FIFO is independent of the response map: another whole Control message
can be written while an earlier command awaits its response. At most four
exchanges exist, with one ATT write outstanding. Messages' fragments never
interleave. Correlation uses requestId, expected response type, STATUS bootId,
and batchId where applicable. Early responses wait for the final write callback.
Local commands with stale generations/leases/tokens are rejected.

Resources/deadlines:

| Resource | Bound/action |
| --- | --- |
| Command exchanges / write queue | 4; further local requests are rejected |
| Output event queue | 32; overflow closes instead of accumulating |
| LIVE_SAMPLE | One overwriteable RAM slot, separate from the event queue |
| Journal packet | At most 100 validated entries plus BEGIN/END |
| Fragment assembly | 5 seconds from the first fragment |
| Outstanding ATT write | 5 seconds |
| Entire outgoing fragment sequence | 5 seconds from its first write attempt, not extended per fragment |
| Queued/unfinished Control message | 30 seconds total from enqueue |
| First command response | 5 seconds after final successful write callback |
| Batch reception | 30 seconds from BEGIN, unaffected by LIVE traffic |
| External commit and ACK/CANCEL completion | Within 30 seconds after END |
| Control IDs | 0..65534, sequential, never wrap; close when exhausted |
| Events IDs | 0..65535, bitmap, no ordering assumption; close when all consumed |

LIVE_SAMPLE is accepted only after handshake with Info v1.1/capability 0x0010,
the STATUS bootId, strictly increasing sampleCounter and nondecreasing uptimeMs
within this connection. Invalid ordering/foreign preview bootId is ignored;
malformed frames close the connection. A changed STATUS bootId closes it.
No LIVE_SAMPLE creates an entry, ACK, cursor update or storage operation.
LIVE_READY and GAP_NOTICE are separate capability-gated NOTICE events.
Their eventual persistence policy is outside this module.

## Manual journal and commit tokens

There is no automatic FETCH. Only an available WebView/client may explicitly
acquire the exclusive `acquireJournal(generation)` lease. It must revoke that
lease on disposal, history clear, cancellation or WebView loss. Without a lease,
the service may continue receiving LIVE_SAMPLE but cannot start a journal fetch.
GET_STATUS and explicit TIME_SET also remain available outside a journal lease;
there is no automatic clock synchronization or retry loop.

The journal flow is:

1. `journalStatus` / `fetch(generation, lease, durableCursor, limit)` use the same
   write queue and Events assembler as preview. STATUS-at-end, TIME_PENDING and
   ERROR are explicit results. They do not move any cursor or trigger retry.
2. BEGIN/ENTRY/END must pass request/batch correlation, count, contiguous
   coverage, unique measurement IDs and SHA-256 validation. Only then, and after
   FETCH write completion, a BATCH event exposes an immutable packet and token.
3. `beginCommit(generation, lease, batch.token)` issues a one-use commit token.
   The future bridge starts the existing atomic IndexedDB import of entries,
   cursor and receipt. `commitSucceeded(generation, lease, commitToken)` is
   permitted **only from transaction.oncomplete**, not after individual puts,
   after message delivery, or after an HTTP response. The core cannot prove an
   external database commit; this is an explicit bridge trust boundary.
4. Only that completion queues ACK_BATCH, using the privately retained exact
   batchId/throughSequence/count/digest. The caller cannot substitute ACK fields.
   Another FETCH is blocked until **matching ACK_ACCEPTED and all ACK write
   callbacks** complete. Replayed/foreign/revoked commit tokens cannot queue ACK.

An idle lease can be revoked without disconnecting. Revocation during fetch,
reception, commit or ACK closes the connection and drops unsent writes. A deferred
write must recheck its token as described above. Already issued GATT calls cannot
be recalled; late completion is ignored. No ACK is issued for an uncommitted
packet. `commitFailed` closes without ACK. A validated, uncommitted packet may
instead explicitly use `cancelBatch`; the next FETCH then waits for correlated
CANCELLED and write completion. Other uncertain cancellation paths close.

If commit completes after revocation/timeout, the old token is rejected even
after reconnect, including when requestId/batchId happen to match a new exchange.
Already committed IndexedDB data stays committed. A later manual run resumes
from that durable cursor; this core never rolls back data or owns the cursor.

## JVM tests and Android compilation without APK

Set the existing JDK 21 as `JAVA_HOME`. The standalone JVM run needs no Android
SDK, emulator, GATT or phone. From `mobile/android`:

```powershell
./gradlew.bat -p ble-protocol-core test --no-daemon --console=plain
```

Tests read the existing shared
[`ble-live-sample-v1.1.json`](../../../docs/test-vectors/ble-live-sample-v1.1.json)
directly, with no copied vectors. They check Info compatibility, exact body/CRC/
fragment bytes, uint64 limits, every message/entry layout, canonical digest,
malformed input, timeouts, bounds, full ID exhaustion, early/correlated responses,
reconnect callbacks, lease revocation and commit → ACK → ACK_ACCEPTED ordering.
JVM clocks and transport completions are deterministic test inputs.

With the existing Android SDK configured as `ANDROID_HOME`, compile both app
variants and run the module tests from the Android root:

```powershell
./gradlew.bat :ble-protocol-core:test :app:compileDebugSources :app:compileReleaseSources '-Pandroid.builder.sdkDownload=false' --offline --no-daemon --console=plain
```

This runs the existing debug/release web-asset isolation checks. It does not run
assemble/package tasks, produce APKs, or connect the core to the application.
Use a normal dependency-resolving first JVM run if JUnit is not yet cached.
Reports are in `build/reports/tests/test` and `build/test-results/test` in this
module. The Android compile check validates the unchanged app build graph; it is
not a device/foreground-service integration test.

Successful CRC, protocol reception and JVM tests do not establish SCD41 accuracy.
The prototype's isopropanol exposure limitation remains in the existing
[mobile documentation](../../README.md#simulator-tests-and-prototype-accuracy).
