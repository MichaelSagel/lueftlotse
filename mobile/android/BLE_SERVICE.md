# Explicit Android BLE foreground service foundation

`SensorBleService` owns one `GattTransport` / Java `ProtocolSession`. The service
is started, unbound, non-exported and uses `connectedDevice`; it holds no Activity
or WebView reference. Activity recreation or dismissal does not close its session.
It uses `START_NOT_STICKY`, no boot receiver and no automatic connection/reconnect.
A null restart intent does not open GATT. Process death loses state and the sample.

This is an opt-in native foundation. Angular still uses `BleConnection` behind
`BLE_SESSION`, including its existing background-disconnect behavior and manual
journal download. It does not call `BleService`. The saved binding remains solely
in IndexedDB: the service reads/writes no binding, connection intent or history.
The service exposes no FETCH, commit or ACK method at this stage. The existing
commit → ACK → matching ACK_ACCEPTED contract remains in the core and Angular.
Future WebView integration must use the same service transport and revoke journal
leases on client loss; receiving LIVE_SAMPLE needs no WebView or storage.

## Ownership, ordering and cleanup

The process-wide `BleOwnership` lease is shared by the service and
`GuardedBluetoothLePlugin`. MainActivity appends the guard after auto-discovery
and before Capacitor loads JavaScript; startup checks it replaced `BluetoothLe`.
It delegates to the installed plugin instance (including listeners and permission
launchers), preserving its native method/permission metadata. Only connection
admission and confirmed cleanup are wrapped. No node_modules patch is required.

A second service start, legacy connect while service-owned, and service start
while legacy-owned are rejected. Ownership includes connecting and stopping.
A failed legacy connect keeps its lease until native disconnect succeeds and
connect has settled. Activity destruction queues cleanup of only that legacy
instance before Capacitor's worker quits. If cleanup cannot be confirmed, the
lease stays occupied until process restart; creating another GATT is unsafe.

Bridge commands, service intents, state updates and cleanup callbacks are
serialized on Android's main looper. Only the transport's HandlerThread accesses
GATT/the core. Each run has an opaque `runId`; callbacks also check the concrete
connection identity. Duplicate starts do not open another transport, duplicate
stops are harmless, and an old notification/callback cannot stop or mutate a new
run. Ownership is released after confirmed native close; a failed close remains
an explicit error with the lease retained. The service stops and removes its
notification after cleanup. A pending start has a 10-second deadline, while
transport connection/operation/core deadlines remain in force.

## Android permissions and notification

Installed versions: Capacitor **8.5.3**, community BLE plugin **8.3.0**,
minSdk **24**, compileSdk/targetSdk **36**, JDK **21**. No dependency was added;
the app references the existing `ble-gatt-transport` Gradle project.

| Android version | Service requirements |
| --- | --- |
| API 24–30 | Manifest BLUETOOTH / BLUETOOTH_ADMIN (maxSdk 30); no service scan/location request |
| API 28+ | Manifest FOREGROUND_SERVICE |
| API 31+ | Granted runtime BLUETOOTH_CONNECT |
| API 33+ | Granted runtime POST_NOTIFICATIONS under this app's visible-notification policy |
| API 34+ | Manifest FOREGROUND_SERVICE_CONNECTED_DEVICE plus BLUETOOTH_CONNECT prerequisite |

The existing UI's scan/location permissions are preserved. The service connects
to an explicit address and does not scan or pair. Grants and notification/channel
availability are checked before reserving a run and again inside the service,
before creating the transport. Missing permission means no GATT is opened.

`start` requires a RESUMED Activity and never requests permissions implicitly.
The service promptly calls `startForeground` before connecting. These choices
follow Android's [foreground service launch rules](https://developer.android.com/develop/background-work/services/fgs/launch)
and [connectedDevice prerequisites](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device).
Android does not itself require POST_NOTIFICATIONS to start an FGS; this app
requires it and enabled notifications so the user can see **Trennen** in the
drawer. See the [notification permission behavior](https://developer.android.com/develop/ui/views/notifications/notification-permission).

The low-importance channel **Sensor-Verbindung** has no sound, vibration or badge.
The ongoing notification is **Lüftlotse Sensor**, initially **Verbindung wird
hergestellt**, then **Sensor verbunden** after handshake. Its **Trennen** action
targets the non-exported service with an immutable PendingIntent and the runId.
It closes that session and never schedules reconnect. This notification reports
the connection; no CO₂-threshold notification exists yet.

## Local Capacitor bridge

The local plugin is registered as `BleService`. A future caller can use
`registerPlugin('BleService')` from `@capacitor/core`. There is deliberately no
Angular provider/adapter selecting it in this stage.

| Method | Input / behavior |
| --- | --- |
| `requestPermissions()` | Visible Activity only; requests CONNECT on API 31+ and POST_NOTIFICATIONS on API 33+. Resolves state and never starts a service. |
| `start({ bleAddress, expectedDeviceId? })` | Explicit MAC address; optional Info UUID v4 expectation. Returns starting state with runId; poll getState for handshake completion or error. A UUID mismatch closes without writing any binding. |
| `getState()` | Returns a snapshot; no start, new GATT, subscription or persistence. |
| `disconnect({ runId })` | Mandatory current-run token. Returns stopping/stopped state; poll until cleanup completes. A stale token has no effect. |

Snapshot fields: `state` (`stopped`, `starting`, `connecting`, `ready`, `stopping`,
`error`), `owner` (`none`, `legacy`, `service`), `runId`, `bleAddress`, `deviceId`
(only after STATUS handshake), `reason`, `permissionsGranted`, `lastSample`,
`sampleAvailable`, `nowElapsedMs`. No numeric uint64 crosses the bridge.

Example `lastSample` (null until a valid post-handshake preview):

```json
{
  "type": 138,
  "bootId": "12345678-1234-4234-8234-123456789abc",
  "sampleCounter": "18446744073709551615",
  "uptimeMs": "18446744073709551615",
  "ppm": 1200,
  "receivedAtElapsedMs": "73421"
}
```

Version/capability, bootId, increasing counter and nondecreasing uptime validation
remain in the core. `receivedAtElapsedMs` is `SystemClock.elapsedRealtime()` when
the final Events fragment arrived, before the transport queue processes it. This
clock includes sleep and is not wall time. `nowElapsedMs` uses the same clock.
Both times and all wire uint64 values are decimal strings; JS callers use BigInt
for arithmetic. Repeated getState calls return the same cached sample timestamp.
No Date.now()/delivery time is substituted on Activity recreation.

The sample is available only while ready, before 15 seconds have elapsed, and
until a SENSOR_ERROR notice. A new valid sample restores availability. Disconnect
retains the last sample/time for inspection but marks it unavailable; a new run
clears it. The bounded cache holds only one immutable sample in RAM, with no
IndexedDB, file, history or backend write.

## Verification and limits

From `mobile/android`, with the existing JAVA_HOME (JDK 21) and ANDROID_HOME:

```powershell
./gradlew.bat :ble-protocol-core:test :ble-gatt-transport:testDebugUnitTest :app:testDebugUnitTest :ble-gatt-transport:compileDebugSources :ble-gatt-transport:compileReleaseSources :app:compileDebugSources :app:compileReleaseSources '-Pandroid.builder.sdkDownload=false' --offline --no-daemon --console=plain
```

These targets run JVM tests and compile both Android variants, including the
existing web-asset isolation checks; they do not package APKs. Tests cover grants
at API boundaries, lifecycle state, competing owners, pending cancellation,
notification run tokens, idempotent close, stale callbacks, Activity-reader
replacement, original receipt time, 15-second freshness and exact uint64 strings.
Reflection tests pin the guard's API metadata to the installed BLE plugin.
Core/shared-vector and fake-GATT tests remain part of the same command.

The JVM lifecycle tests exercise the pure service state machine and ownership
gate, not Android framework dispatch. On-device permission dialogs, actual
notification actions, Activity recreation, screen lock/Doze and radio behavior
still need testing when an APK is authorized. An FGS improves process priority;
it does not guarantee unlimited execution or survival of force-stop, process
kill, OEM power management or radio loss. There is no wake lock or restart loop.

Successful reception does not establish measurement accuracy. The SCD41 in this
prototype previously had isopropanol on its membrane; its accuracy remains
unverified, as described in the [mobile documentation](../README.md#simulator-tests-and-prototype-accuracy).
This is a limitation of our sensor, not of LIVE_SAMPLE or the BLE protocol.
