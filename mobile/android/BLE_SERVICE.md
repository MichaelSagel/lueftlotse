# Android BLE foreground service

`SensorBleService` owns one `GattTransport` / Java `ProtocolSession`. The service
is started, unbound, non-exported and uses `connectedDevice`; it holds no Activity
or WebView reference. Activity recreation or dismissal does not close its session.
It uses `START_NOT_STICKY`, no boot receiver and no automatic connection/reconnect.
A null restart intent does not open GATT. Process death loses state and the sample.

On Android the route selects `NativeBleSession` as the only `BLE_SESSION` for the
page, discovery and manual journal download. Attaching the first UI reader runs
the idempotent [binding migration](BLE_BINDING.md), including a confirmed empty
binding. Migration/read/deletion errors block connection with a German message;
there is no fallback transport. Migration never starts GATT. **Verbinden** is the
only connection trigger. Browser routes select `BrowserBleSession`: history
remains accessible, but native calls and migration are forbidden.

The service receives LIVE_SAMPLE independently of the WebView, without storing
it. [Manual download](BLE_JOURNAL_BRIDGE.md) uses the same transport and retains
the TypeScript atomic IndexedDB commit → ACK → matching ACK_ACCEPTED contract.

## Ownership, ordering and cleanup

The process-wide `BleOwnership` lease is shared by the service and
`GuardedBluetoothLePlugin`. MainActivity appends the guard after auto-discovery
and before Capacitor loads JavaScript; startup checks it replaced `BluetoothLe`.
It delegates scan initialization, permissions and listeners to the installed
plugin, preserving method/permission metadata. Every legacy GATT/bonding method
is rejected before delegation, even before migration. No node_modules patch is
required. `BleConnection` remains only for explicit fake-adapter protocol tests.

`BleScanner.holdStopped()` blocks new searches, waits for a pending scan launch,
and awaits native stop before permissions/start. `ScanGate` also holds native
admission while a scan is launching/active or its stop is uncertain. The installed
BLE plugin 8.3.0 swallows IllegalStateException in stopLEScan, so the local guard
calls its public DeviceScanner.stopScanning directly through the pinned private
deviceScanner field. Reflection contract tests check this dependency; review it
on plugin upgrades (release currently has minification disabled). A successful
Android stopScan return is the available API confirmation; Android supplies no
separate radio-completion callback. Exceptions reject stop and retain admission.
An uncertain stop cannot start GATT. Activity destruction only cleans its scanner;
it never disconnects the service. Failed cleanup retains ownership until confirmed
cleanup or process restart. A second service start is rejected throughout connect,
ready and cleanup.

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

The UI calls `requestPermissions` from the visible Activity before `start`.
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
It persists disabled connection intent before closing that session and never
schedules reconnect. A storage failure still closes the connection, leaves an
explicit `bindingError` in state and shows a German error toast for notification
actions. Bridge actions reject their promise instead of reporting success.
This notification reports
the connection; no CO₂-threshold notification exists yet.

## Local Capacitor bridge

The local plugin is registered as `BleService`. The selected Android
`NativeBleSession` and `NativeBleBinding` share this bridge. Constructors have no
IO; first client attachment migrates/reads and polls, but never connects.

| Method | Input / behavior |
| --- | --- |
| `requestPermissions()` | Visible Activity only; requests CONNECT on API 31+ and POST_NOTIFICATIONS on API 33+. Resolves state and never starts a service. |
| `start({ bleAddress, expectedDeviceId? })` | Requires completed binding migration. Explicit MAC address; the persisted UUID is enforced, plus any explicit expectation. Returns starting state with runId; poll getState. New identity/address and enabled intent are saved only after STATUS. |
| `getState()` | Returns a snapshot; no start, new GATT, subscription or persistence. |
| `disconnect({ runId })` or `disconnect({ revision })` | Current-run token, or checked binding revision only when no run exists after process restart. Commits disabled intent before closing; storage failure still closes an existing run and rejects. Poll until cleanup completes. Stale tokens/revisions cannot stop a newer run. |
| `getBinding()` | Confirmed repository snapshot; an IO/decode error rejects, never returns an empty binding. |
| `migrateBinding({ binding })` | One-time import or explicit null; returns the existing snapshot after completion. See the migration coordinator contract. |
| `forgetBinding({ revision })` | Persists an empty migrated record, then closes the native session. Stale revisions have no effect. |

The [manual journal bridge](BLE_JOURNAL_BRIDGE.md) exposes an exclusive WebView
lease and commit-token/ACK handshake over this same transport. Hiding/destroying
the WebView revokes only its journal client. If journal cancellation cannot be
safe (a request/packet/ACK is pending), the core closes the connection without
an unconfirmed ACK. With no pending download, backgrounding or screen lock keeps
the service connection; collapsing discovery never disconnects it.

Snapshot fields: `state` (`stopped`, `starting`, `connecting`, `ready`, `stopping`,
`error`), `owner` (`none`, `legacy`, `service`), `runId`, `bleAddress`, `deviceId`
(only after STATUS handshake), `reason`, `bindingError`, `permissionsGranted`, `lastSample`,
`sampleAvailable`, `nowElapsedMs`, negotiated `info`, and correlated `status`.
No numeric uint64 crosses the bridge.

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
No Date.now()/delivery time is substituted on Activity recreation. On resume or
reader reattachment the UI can display that cached sample only for its remaining
15-second lifetime, computed with BigInt native time differences plus conservative
bridge transit time. Duplicate state reads do not restart its timer. An expired
sample remains unavailable; no new sample timestamp is invented.

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
