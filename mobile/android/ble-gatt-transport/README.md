# Android GATT transport

This Android library owns a single `BluetoothGatt` and drives the existing
[`ble-protocol-core`](../ble-protocol-core/README.md). The app now depends on this
module through the explicitly started [service foundation](../BLE_SERVICE.md).
The active TypeScript `BLE_SESSION` / `BleConnection`, IndexedDB binding owner,
UI and firmware are unchanged. The native ownership guard prevents concurrent
legacy-plugin and service connections. This transport has no pairing, automatic
connection/reconnect, binding migration or storage.

No external library/version was added: the module references the existing core
project and reuses the already installed JUnit version for tests. Production
code uses only Android/JDK APIs, with compileSdk 36 and minSdk 24 from the root.

## Components and ownership

- `GattTransport`: platform-independent coordinator, private protocol core,
  one reserved connection slot, operation ordering, cancellation, deadlines and
  bounded queues. Its `Connection` object is the attempt identity/generation;
  the core also has its own opaque connection generation and write tokens.
- `GattBoundary`: small interface used by the coordinator and fake JVM radio.
- `AndroidGattBoundary`: the only class accessing Android Bluetooth objects.
  It validates the service/characteristic/CCCD objects and isolates old and new
  value-based Android callbacks and write APIs.
- `SerialLoop`: injectable serial queue, monotonic clock and cancellable timers.
- `AndroidGattTransport.create`: explicit factory using an application Context,
  BluetoothAdapter and Listener. It owns a HandlerThread and uses
  `SystemClock.elapsedRealtime()`. Only the explicitly started native service
  invokes it; Angular does not.

The service must acquire the shared native ownership lease before constructing
this transport; the installed plugin's guarded connect uses the same lease pool.
The caller is responsible for Android Bluetooth
permissions and an enabled adapter; SecurityException/rejected operations fail
the attempt and trigger cleanup, with no permission prompt or pairing attempt.

## Connection and operation sequence

`connect(address, expectedDeviceId)` reserves the only slot synchronously, even
before the queued Android call. Another connect is rejected while reserved,
connecting, ready or awaiting cancellation cleanup. `expectedDeviceId` can be
null for a first manual connection; otherwise Info UUID must match. This argument
does not read, write or migrate any binding.

The owner loop executes:

1. `connectGatt(..., autoConnect=false, TRANSPORT_LE)` and a successful CONNECTED
   callback from that GATT instance.
2. Discovery and a successful services-discovered callback. Require exactly one
   protocol service, Info with READ, Control with WRITE (with response), Events
   with NOTIFY and its CCCD. Missing, duplicate or incompatible objects fail.
3. Info read and a successful callback, exact codec/version/capability/UUID
   validation, and optional expected-device UUID validation.
4. Local Events notification enable and CCCD `ENABLE_NOTIFICATION_VALUE` write.
   Wait for the successful descriptor-write callback.
5. Open the private protocol core and pump GET_STATUS. `Connection.ready()`
   completes only when the core accepts the correlated STATUS **and** every
   successful Control write callback. Early notifications cannot complete it.

Every Control fragment uses `WRITE_TYPE_DEFAULT`, including the API 33 value
overload and the older characteristic-value API. One ATT operation is outstanding
at a time. The next fragment waits for its write callback; the next complete
message does not wait for the previous command's protocol response. RequestId
correlation stays in the core. Platform behavior follows the Android
[BluetoothGatt](https://developer.android.com/reference/android/bluetooth/BluetoothGatt)
and [BluetoothGattCallback](https://developer.android.com/reference/android/bluetooth/BluetoothGattCallback)
contracts. API 33+ uses the supplied callback value; API 24–32 immediately copies
the characteristic value. Info and Events are copied again before enqueueing at
the fakeable boundary, so later buffer mutation cannot alter core input.

All core access and normal GATT calls occur on the same owner loop. Callback
statuses, expected phase, characteristic/descriptor identity, GATT identity and
Control write token are checked before advancing. Android service changes close
the connection; this transport does not rediscover on the same generation.

## Deadlines, cancellation and bounds

- Connect callback: 10 seconds. Discovery, Info read and CCCD write: 5 seconds
  each. Handshake has an outer 10-second bound and the core's stricter write /
  response / fragment deadlines.
- Ticks run every 100 ms and on input; elapsed time includes sleep. Late callbacks
  are rejected even when the Handler timer has not run yet. Handler scheduling
  does not guarantee execution while Android suspends or kills the process.
- Core framing, write, command, batch and ID-exhaustion limits remain unchanged.
  Core CLOSED causes physical GATT cleanup, including loss of Events validity.
- At most 128 queued boundary callbacks and 32 queued caller commands. Events
  frames and Info are limited to 20 bytes before copying. Callback overflow closes
  instead of dropping arbitrary fragments; excess caller commands are rejected.
- `Connection.cancel()` marks the attempt invalid immediately, then performs
  idempotent cleanup on the loop. Unsent commands cannot act after cancellation.
  Disconnect is followed by close even if disconnect throws. The slot is released
  only after successful close. If close itself throws, `closed()` fails and this
  owner keeps the slot reserved instead of risking a second GATT; disposal can
  still stop its loop. Late callbacks cannot touch a later connection.
- If cancellation happens while `connectGatt` is returning a handle, that handle
  is closed before any discovery. Native synchronous Android calls cannot be
  forcibly interrupted; elapsed deadlines are checked on return and the slot
  remains reserved during that call. An already closed GATT is never reopened by
  a late CONNECTED callback. An unexpected late handle is also closed after loop
  shutdown; this exceptional cleanup does not access the core.
- `GattTransport.close()` permanently disposes the owner and its loop. Callback /
  command enqueue races with shutdown are handled without using a new session.

Listener events and CompletionStage continuations may run on the owner loop:
consumers must not block it or wait there on transport futures. Dispatch UI /
database work elsewhere. This is a transport, not a background-execution guarantee.
Real-radio behavior and Android lifecycle/power management still need device tests
at the later integration stage.

## Preview and manual journal

The listener gets immutable core events and accepted current LIVE_SAMPLE values.
`live(connection, sample, receivedAtElapsedMs)` includes the monotonic receipt
time of the final Events fragment, captured before posting to the owner queue.
Delayed processing, polling and replaying state must not refresh this timestamp.
`SerialLoop.now()` is consequently thread-safe, including callback threads.
LIVE_SAMPLE is never saved and never creates ACKs. No journal command is automatic.
The eventual available WebView explicitly acquires a journal lease and passes it
to fetch/commit/cancel/revoke methods; these delegate to the private core on the
same loop and GATT. On WebView loss the future owner must revoke that lease.

Command futures return the local command ID/token or validation failure. They
do **not** mean a response or an atomic database transaction has completed.
The existing core commit contract remains: the bridge calls `commitSucceeded`
only after IndexedDB transaction.oncomplete. The next FETCH waits for the core's
matching ACK_ACCEPTED and final ACK write callback. The transport has no database,
cursor, binding or HTTP implementation and no generic raw-GATT/core escape hatch.

## Validation without APK

With the installed JDK 21 (`JAVA_HOME`) and Android SDK (`ANDROID_HOME`), run from
`mobile/android`; all dependencies must already be cached:

```powershell
./gradlew.bat :ble-protocol-core:test :ble-gatt-transport:testDebugUnitTest :ble-gatt-transport:compileDebugSources :ble-gatt-transport:compileReleaseSources :app:compileDebugSources :app:compileReleaseSources '-Pandroid.builder.sdkDownload=false' --offline --no-daemon --console=plain
```

No assemble/package APK task is used. Existing app debug/release web-asset checks
still run. The coordinator's JVM tests use a fake GATT boundary and deterministic
serial clock without Android runtime objects, a phone, Mockito or Robolectric.
They cover order, callback statuses, rejected operations, permissions, UUID checks,
timeouts, cancellation during connect, late callbacks, shutdown races, one-session
exclusion, copied buffers, bounds, serial writes and the manual commit/ACK flow.
The existing core tests continue reading the shared binary vectors unchanged.
