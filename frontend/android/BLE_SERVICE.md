# Android BLE foreground service

`SensorBleService` owns one `GattTransport` / Java `ProtocolSession`. The service
is started, unbound, non-exported and uses `connectedDevice`; it holds no Activity
or WebView reference. Activity recreation or dismissal does not close its session.
It uses `START_NOT_STICKY`, no boot receiver and no process/boot service startup.
An already confirmed connection may reconnect within the same live service run.
A null restart intent does not open GATT. Process death loses connection state and
the preview cache, but committed native measurements remain on disk.

On Android the route selects `NativeBleSession` as the only `BLE_SESSION` for the
page, discovery and manual journal download. Attaching the first UI reader runs
the idempotent [binding migration](BLE_BINDING.md), including a confirmed empty
binding. Migration/read/deletion errors block connection with a German message;
there is no fallback transport. Migration itself never starts GATT. After migration,
opening/returning to the visible Android app checks existing permissions and
reattaches an active, starting or retrying service without duplication. If idle,
a new opening enables connection intent again, including after Trennen. Polling
never enables it. No Android connection-control button or device list is shown.
A downward pull invokes the existing native automatic-start command, resuming
an idle connection and preserving an active/searching run.
Browser routes select `BrowserBleSession`: history
remains accessible, but native calls and migration are forbidden.

The service receives and stores LIVE_SAMPLE independently of the WebView.
[Manual download](BLE_JOURNAL_BRIDGE.md) uses the same transport and retains
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
run. Ownership stays reserved between retry attempts and is released after
confirmed terminal close; a failed close remains an explicit error with the lease
retained. The service stops and removes its notification after terminal cleanup
and accepted writes drain. A pending start has a 10-second deadline, while
transport connection/operation/core deadlines remain in force.

## Native automatic discovery and connection

The Android route calls `startDiscovery({revision, manual})`, after draining any
legacy plugin scan through `BleScanner.holdStopped()`. `SensorBleService` owns
the entire new search/connection loop under its SERVICE ownership lease; no
WebView timer or plugin scanner is needed after startup. The normal Android UI
has no sensor-selection dialog, device list, Verbinden or forget button.
During discovery the CO2 card shows **Sensor wird gesucht …**. There are no
connection buttons on the Android main screen. The unchanged service notification
retains **Trennen** to stop connection and search. Within the same visible opening,
polling cannot restart them; pulling down, returning to the app or attaching
a fresh UI starts again. A saved deviceId is checked on every handshake; no other identity is bound.

With an enabled binding, the first attempt uses the saved address directly.
After failure, `ServiceDiscovery` runs 8-second scan windows separated by
1/2/4/8/16/30-second pauses (cap 30). Scan/timer/GATT attempts are serialized.
`NativeSensorScanner` applies both an Android ScanFilter for `Codec.SERVICE`
(`9c6b1000-7a3e-4d9f-8b52-6e210f42a001`) and an advertisement UUID check. Other
advertisers are never sent to the UI. GATT opens only after scan stop returns.
Every saved-device attempt uses the persisted deviceId as the expected Info
identity in the existing handshake, even if a discovered address changed.
Wrong-identity/unsupported candidates are quarantined for this run; a different
sensor is never silently bound. LIVE_SAMPLE support is checked before binding.

With no binding, one service advertiser is connected automatically. Several
advertisers pause discovery and expose only those candidates for explicit
selection; protocol/identity compatibility is verified when connecting. No
unfiltered device picker is opened. Choice commands carry the current runId;
stale addresses are rejected. Each attempt repeats the regular handshake.

Trennen from UI or notification disables durable connection intent, cancels the
scan/timer and current GATT attempt, and fences late callbacks. Intent also
persists when no sensor has ever been bound. The internal forget bridge remains available but has no Android UI action. No process/boot auto-start, SQLite migration or CO2-alert change is added.
Scan permission is required (BLUETOOTH_SCAN on API 31+, fine location on older
Android, plus background location on API 29–30). Android 11 users may need to
select Standort / Immer zulassen in app settings; the UI explicitly reports
this prerequisite rather than starting a scan without the required grant.
Permission loss stops the loop. As before, no wake lock is taken.

### Android pull-to-refresh (2026-11-17)

The main screen has no connection controls in any state. A downward vertical
single-finger pull of at least 80 CSS pixels, starting at scroll position zero
outside form controls, invokes the existing NativeBleSession client command.
Short, mostly horizontal, cancelled and multitouch gestures are ignored; an
in-flight refresh blocks duplicate gestures. Active connection/search is retained
without a second native run. Errors remain exposed by BLE_SESSION. Browser touch
gestures do not invoke native connection commands. No native service, notification,
SQLite or alert implementation was changed. Targeted checks: 13 connection-UI
cases and 7 page cases passed. Production/USB-debug assets and the main debug APK built successfully;
`adb install -r` updated the main package without clearing data. At the first
attempt POCO was locked (NotificationShade/keyguard), so actual-device swipe
verification initially waited for unlock. After the user opened the app, the
actual POCO WebView showed only the history-loading button while connected
(real value 687 ppm); no connection controls or device list were present.
For a controlled idle baseline the existing native disconnect bridge was called:
state became stopped/owner=none, binding revision 30 disabled. With the app kept
visible, a downward touch sequence of 144 CSS pixels was injected through CDP
Input.dispatchTouchEvent on the CO2 card at scroll position zero. No direct
connect bridge command was used to substitute for the gesture. The gesture
started run bab7a758-dc5d-4c12-939b-b0a7edd44c15, connection
20d870b0-ccdc-44d2-962f-021c268c4d09. At 2026-11-17 15:09:12 CET it was ready
with the same saved deviceId a521be49-defd-4474-9a29-aa15034d7da1, enabled binding
revision 31, a fresh real sample (counter 1444, 696 ppm) and no binding/storage
error. A second downward touch sequence while ready retained both runId and
connectionId: no redundant connection was opened. The rendered screen still
contained only history loading. This was an actual-phone gesture test injected
through DevTools, not a physical finger gesture or synthetic sensor data.
The Android notification implementation was unchanged.

### Android pull indicator (2026-11-17)

An Android-only decorative ring expands above the CO2 card as a downward pull
progresses. A qualifying pull latches the visual indicator while the existing
connection request or native connecting/reconnecting state is active. When that
state ends, or a gesture is cancelled/already connected, opacity and height ease
to zero over 200 ms. The ring adds no text, buttons or live region. Reduced-motion
preferences disable transitions/rotation. No native connection/notification,
storage, alert or browser behavior was changed.

Eight targeted page tests passed, including appearance, cancellation, retention
through connecting, disappearance at ready and absence in browsers. Production,
USB-debug assets and the main debug APK built; adb install -r updated POCO without
clearing data. Hardware checks used CDP Input touch events in the actual WebView,
not synthetic measurements or a direct-connect substitute. During pulling the
ring was visible above the card (screenshot inspected). After cancellation its
opacity was about 0.50 at the first sampled frame and zero after transition;
with an already-ready connection the corresponding values were about 0.69 and
zero. RunId and connectionId stayed unchanged in those cases.

For the connecting case the existing disconnect bridge prepared a confirmed
stopped baseline (binding revision 32). A downward touch gesture started run
387598f3-91bd-4903-9b78-a3679d6508a1 and connection
e474157a-4b7f-4689-ae39-70fcf7d48de4. The ring remained fully visible at height
44 CSS pixels during startup; getAnimations reported running and its transform
changed between sampled frames (animation times approximately 50 and 450 ms).
At the later sample (roughly 1.8 seconds plus diagnostic overhead), native state
was ready for the saved deviceId and the indicator had opacity/height zero with
no running animation. No binding/storage error was reported. This verifies the
normal connect/handshake interval; a prolonged unavailable-sensor scan was not
repeated for this visual change. Temporary diagnostic scripts/screenshots remain
outside the repository. git diff --check passed.

### Current connect/forget-free UI verification (2026-11-17)

The changed UI/facade/page checks passed (50 tests at the first checkpoint).
The visibility guard then passed all 37 native-facade tests; the CO2-card status
check passed with all 5 page tests. An additional regression for first visibility
of a WebView created behind the lock screen passed (37 other cases skipped).
Production/USB-debug assets and the main debug APK built successfully.
`adb install -r` updated `de.lueftlotse.app` on POCO without clearing data.
The loaded DOM showed neither connect/forget buttons nor a device list.
The phone was locked (NotificationShade/keyguard), and asynchronous bridge reads
timed out. At that checkpoint hardware checks were pending user unlock; the completed
current-APK sequence is recorded below, separately from older APK observations.
No synthetic samples, SQLite changes, backend or adb reverse were used.

POCO follow-up with the current APK: opening the unlocked app automatically
reconnected the saved deviceId a521be49-defd-4474-9a29-aa15034d7da1; binding
revision 27 was enabled. The rendered screen exposed only Trennen and history
loading, with no connect/forget actions, dialog or BLE-device list. After the user
removed ESP32 power, GATT closed with status 8 and the CO2 card displayed
Sensor wird gesucht … with cancellable Trennen. Logs confirmed serialized
8-second UUID-filtered scans and increasing pauses capped at 30 seconds.
Initially the powered-on check had no matching scan results, so it was not
reported as success. After the user confirmed ESP32 startup, the same logical
run 3cf44fc4-a235-454c-937f-74da594d9fab found and handshook the saved identity
without a UI command. At 2026-11-17 13:11:07 CET the bridge was ready with a new
connectionId b7728c28-3138-49b5-b51b-aef9dbde3b65 and new bootId
b1e5e488-4c0c-44e2-8e4e-ac46b2405b53 (previously
8ef4d343-826f-4c88-be2b-1e418c222134). A real LIVE_SAMPLE counter 6, uptime
31311 ms, 745 ppm was fresh; binding/storage errors were null. This verifies
recovery after power-on, but not a precise latency from the user's switch action.
Current-APK cancellation was then confirmed with ESP32 powered off: the user
pressed Trennen in the open main app while native discovery was retrying. The
bridge reported stopped, owner=none, reconnecting=false and discoveryMode=null;
binding revision 28 retained the same UUID/address with connectionEnabled=false.
No connection action or device list remained visible. After the user powered
ESP32 back on, continuous observation from 2026-11-17 13:13:26.129 to
13:14:38.845 CET (72.716 seconds) recorded zero SCAN_START and zero BLE attempt
entries. The Python observer and its adb logcat child were verified alive during
the interval. Final state remained stopped/owner=none with disabled revision 28,
no binding/storage error and only the history-loading button. The app was kept
open throughout; no UI/bridge command enabled connection. After the user backgrounded and reopened the app (ESP32 left on), the native
service automatically started a new logical run db4c397c-9d9b-4558-9e18-625ea5f7d3cd
and connection a8d3300e-fe63-4808-b7aa-ac81c16856e3 without a connect-button action.
At 2026-11-17 13:15:29 CET it was ready with the same saved deviceId/address,
binding revision 29 and connectionEnabled=true. A fresh real sample counter 27,
uptime 132501 ms, 767 ppm was available and shown in the CO2 card; binding and
storage errors were null. Only Trennen and history loading were visible, with
no dialog or device list. Thus Trennen suppressed retries within the same opening,
while a subsequent app opening resumed connection. No phone settings, app data,
history implementation or CO2 alert code were changed for these observations.

### Earlier UI verification (before removal of connect/forget buttons)

The observations below refer to the preceding APK and its old button labels;
they are preserved as hardware evidence, not as the current UI specification.

Verification status (2026-11-17): the earlier binding/state/component/platform
checks were retained. Remaining changed code passed 9 ServiceDiscovery JVM cases,
36 native-facade cases, 3 new API-level discovery-permission cases and 2 selected
legacy-permission UI cases. After restoring the browser's original binding-read
button lock, the affected component passed 10 cases. One new routeDiscovery case
confirmed a single native bridge start for multiple attached readers; the other
platform cases were skipped rather than repeated. Production/USB-debug assets
and the main debug APK built successfully; git diff --check passed.

The APK package was checked as `de.lueftlotse.app`; native discovery classes were
present and the temporary Co2Probe class absent. Its SHA-256 is
`8e1d687524983569c187b892ac86ccda108e7ca1a791d40ca081a29750671d77`.
ADB initially had no attached device, so installation was deferred. After POCO
OZFQ4PHIE68HSWRW appeared as device, this exact main APK was installed with
`adb install -r` successfully, without uninstall/data clearing. The old BLB1
binding (revision 22, same saved UUID/address, connectionEnabled=false) remained
readable. Opening showed Verbinden/Gerät vergessen, no picker and no connection,
respecting the persisted Trennen. Normal UI Verbinden enabled intent and started
the saved-UUID attempt; the UI then showed Sensor wird gesucht … with enabled
Trennen and no device list. Logs showed serialized UUID-filtered 8-second scan
windows and pauses capped at 30 seconds. The latest binding read retained the
same identity/address with connectionEnabled=true.

The controlled POCO cold-opening-with-ESP32-off, later power-on, nearby-foreign-
device and Trennen-during-search observations were completed in the steps below.
No phone data/settings were cleared. Prior POCO reconnect/notification experiments
do not verify those new discovery-loop scenarios.

During the first attempted off-at-opening check, the current service was closed
without disabling intent and MainActivity was cold-started. The app automatically
opened a new run/connection without a chooser, verified the same saved deviceId
and received advancing real LIVE_SAMPLE counters (37 to 51, uptime 180541 to
248001 ms, last reading 1245 ppm). The peripheral was therefore still reachable;
this confirms saved-device automatic connection when available, not the required
unavailable-at-opening case. At this stage a confirmed power-off was still needed.
No conclusion about switched-off recovery is drawn from this first run.

After the user confirmed full power removal, the established link closed with
GATT status 8 and samples became unavailable. A second controlled cold opening
preserved revision 25 / enabled intent and the saved UUID. Its direct connection
attempt timed out after approximately 10.093 seconds, followed by a 1-second
pause, an 8-second UUID-filtered scan, then a 2-second pause and the next window.
The UI showed Sensor wird gesucht …, enabled Trennen and Gerät vergessen, with
no open dialog or device list. No parallel GATT attempt appeared in the captured
sequence. This confirmed the unavailable-at-opening phase before the power-on
and cancellation checks below.

After the user switched ESP32 back on without pressing Verbinden, the same
logical run (`c34f81e4-cc30-4d84-aee8-ab3ea6749297`) completed a scan window,
stopped scanning and opened one new GATT attempt. The service reached ready
with the same saved Info UUID/address and unchanged binding revision 25.
BootId changed from `b9ffa482-77bb-4c8e-afdb-2f80acb66402` to
`9ec82145-935f-4722-b641-c4eec0ce944a`. Native state contained a fresh real
LIVE_SAMPLE (counter 99, 1128 ppm, approximately 2284 ms old), with no binding
or live-storage error. The keyguard/screen-off check showed the phone locked;
the native service recovered without an active UI reader. The hidden WebView
still displayed its old waiting text, so visible UI refresh after unlock is a
separate observation, not inferred from the native sample. Search cancellation
and nearby-foreign-device conditions were then checked as follows.

For cancellation the peripheral was powered off again. The user's first report
of pressing Trennen did not match main-app state: search continued and revision
25 still had enabled intent. The cause of that initial action not reaching the
main handler was not established. Retesting the existing main-app button via
HTMLElement.click in its debug WebView exercised the normal UI handler and
persisted revision **26**, connectionEnabled=false. The service stopped with
owner=none, discoveryMode=null and the UI changed to enabled **Verbinden**.
Cancellation occurred in a pause between scan windows; it does not establish
that the initial physical tap succeeded. Active-scan/late-callback cancellation
is additionally covered by the targeted JVM tests.

After the user switched ESP32 on again, the phone-time observation interval was
**2026-11-17 11:40:30.113–11:41:30.557 CET (60.444 seconds)**. The live observer
and its adb logcat child were verified running across the interval. There were
**zero SCAN_START events and zero GATT attempts**; the exact main BLE service
was absent afterwards. Native state remained stopped/owner=none, binding revision
26 stayed disabled, and the UI retained enabled Verbinden with no open dialog.
No connect button was pressed during that observation.

The user confirmed other powered BLE devices were nearby. The captured search
used the Lüftlotse service-UUID filter; the checked UI exposed no generic device
list or chooser and recovered only the saved deviceId. This confirms the observed
UI behavior under that reported condition, not a measured count of rejected
foreign advertisement packets. No phone settings, SQLite implementation or CO2
alert code were changed for the experiment; app data was not cleared. Temporary
observers, screenshots/APKs and raw logs are excluded from repository changes.

## Legacy explicit-address reconnection

`ServiceReconnect` is created by an explicit service start and is armed only
after that run completes the normal Info/CCCD/STATUS handshake and confirms the
saved binding. A visible app opening may request `startSaved`; constructors,
null restart intents, process restart alone and phone boot never schedule it.

An unexpected physical close is retryable only after confirmed native GATT
cleanup and while the logical run has not been stopped. The foreground service
and ownership lease remain alive while the main-handler timer waits. Requested
delays are 1, 2, 4, 8, 16, 30, 30… seconds; a successful handshake resets them to
1 second. CPU sleep/system scheduling may defer timer delivery; this is not a
wake alarm or a wall-clock reconnection deadline. There is still no wake lock.

At timer delivery the service re-reads the durable binding: connectionEnabled
must be true, and deviceId/address must match this run's confirmed target.
Bluetooth/service permissions are rechecked. Only one timer/attempt is
allowed. Every retry creates a new transport and repeats Info identity validation,
notification subscription and the correlated handshake. A typed
`Connection.identityRejected()` flag makes an Info UUID mismatch terminal;
uncertain GATT cleanup, unreadable/changed intent or missing permissions also
stop retries rather than opening another GATT. No identity is silently replaced.

`Trennen` in the UI or notification and `Gerät vergessen` retain the existing
durable disable/tombstone-before-close actions. The close path always cancels the
timer and current attempt, even if intent persistence failed. Epoch checks fence
already delivered timers, and physical connection checks fence late READY/live/
close callbacks. A cancelled run cannot re-enable its binding through a late
handshake. The confirmed binding revision is carried forward after the first
handshake so a later retry does not fail against its own saved revision.

The logical runId remains stable across retries, including the notification's
Trennen action. Each physical attempt has a different connectionId in getState;
reconnecting=true identifies retry waiting/connecting. The Android facade resets
preview counters and journal capabilities when connectionId changes, even if a
hidden WebView missed the entire retry. The common button remains Trennen and
cancellable during native retries; browser sessions do not expose this flag and
their behavior is unchanged. Explicit closeSession/unsafe journal cancellation
ends this logical run as before; it does not start a retry loop.

Targeted tests cover backoff/cap, one attempt, saved-intent/permission checks,
Trennen while waiting/connecting, persistence failure, forget, stale timer/READY/
physical callbacks, identity rejection and no startup from a saved flag alone.
The on-device reconnect check is separate from the earlier storage/history
experiments below: those earlier results do not verify reconnection.

For that hardware check, connect the saved sensor and record its current bootId,
then background the UI, lock the screen and restart the ESP32. Verify a closed
attempt, a delayed retry with the same deviceId, a fresh handshake and saved
receipts with the new bootId during the locked interval. After notification/UI
Trennen, restart the ESP32 again and observe at least 60 seconds: no new attempt,
no new receipts, service stopped and saved connectionEnabled=false. Inspect only
a read-only database snapshot after the service/write queue has stopped.

Initial reconnect verification passed 40 targeted app JVM tests (including 11
reconnect cases), 6 transport race/identity tests and 35 UI/facade scenarios.
After adding visible-app startup, the affected checks passed 26 app JVM tests
(15 binding actions, 11 reconnect) and 35 native-session/platform UI tests.
Production/USB-debug web assets and the main debug APK built successfully.
The later POCO reconnect results are recorded separately below.

## Android permissions and notification

Installed versions: Capacitor **8.5.3**, community BLE plugin **8.3.0**,
minSdk **24**, compileSdk/targetSdk **36**, JDK **21**. No dependency was added;
the app references the existing `ble-gatt-transport` Gradle project.

| Android version | Service requirements |
| --- | --- |
| API 24–30 | Manifest BLUETOOTH / BLUETOOTH_ADMIN; granted fine location for native scans |
| API 28+ | Manifest FOREGROUND_SERVICE |
| API 31+ | Granted runtime BLUETOOTH_CONNECT and BLUETOOTH_SCAN for discovery |
| API 33+ | POST_NOTIFICATIONS is optional for BLE/storage; required only for visible CO2 alerts |
| API 34+ | Manifest FOREGROUND_SERVICE_CONNECTED_DEVICE plus BLUETOOTH_CONNECT prerequisite |

The service connects to a saved/discovered address, scans only for the service
UUID and does not pair. Bluetooth/scan/foreground-service
grants are checked before reserving a run and again inside the service,
before creating the transport. Missing permission means no GATT is opened.

The UI calls `requestPermissions` from the visible Activity before `start`.
`start` requires a RESUMED Activity and never requests permissions implicitly.
The service promptly calls `startForeground` before connecting. These choices
follow Android's [foreground service launch rules](https://developer.android.com/develop/background-work/services/fgs/launch)
and [connectedDevice prerequisites](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device).
POST_NOTIFICATIONS and enabled notification channels no longer gate BLE,
reconnection or SQLite recording. The mandatory foreground notification is still
provided with **Trennen**; Android may hide it from the drawer when permission
is denied. Only the separate CO2 alert requires visible-notification permission.
See the [notification permission behavior](https://developer.android.com/develop/ui/views/notifications/notification-permission).

The low-importance channel **Sensor-Verbindung** has no sound, vibration or badge.
The ongoing notification is **Lüftlotse Sensor**, initially **Verbindung wird
hergestellt**, then **Sensor verbunden** after handshake. Its **Trennen** action
targets the non-exported service with an immutable PendingIntent and the runId.
It persists disabled connection intent before closing that session and never
schedules reconnect. A storage failure still closes the connection, leaves an
explicit `bindingError` in state and shows a German error toast for notification
actions. Bridge actions reject their promise instead of reporting success.
This notification reports
the connection; CO₂ alerts use the independent channel described below.

## Local Capacitor bridge

The local plugin is registered as `BleService`. The selected Android
`NativeBleSession` and `NativeBleBinding` share this bridge. Constructors have no
IO; first client attachment migrates/reads and polls, but never connects.

| Method | Input / behavior |
| --- | --- |
| `requestPermissions()` | Visible Activity only; requests CONNECT on API 31+ and POST_NOTIFICATIONS on API 33+. Resolves state and never starts a service. |
| `startSaved({ revision })` | Visible-app startup only. Atomically rechecks current binding revision, enabled intent, permissions and idle ownership on the native command queue. Stale/disabled/forgotten/active requests are no-ops. Uses saved MAC/UUID and the normal handshake. No permission prompt. |
| `startDiscovery({revision, manual})` | Current Android route. Visible app + scan/connection grants required. A new app opening enables intent; polling does not. Internal manual calls may enable it too. An active service is never duplicated. |
| `chooseSensor({runId, address})` | Selects one advertised Lüftlotse candidate only from the current unbound choice list. The normal handshake still verifies compatibility. |
| `start({ bleAddress, expectedDeviceId? })` | Requires completed binding migration. Explicit MAC address; the persisted UUID is enforced, plus any explicit expectation. Returns starting state with runId; poll getState. New identity/address and enabled intent are saved only after STATUS. |
| `getState()` | Returns a snapshot; no start, new GATT, subscription or persistence. |
| `getLiveHistory({fromMs, toMs, sort?, pageSize, deviceId?, cursor?})` | Reads native SQLite on an independent worker, without a BLE run, permissions or binding migration. Calendar bounds are decimal millisecond strings, `[fromMs, toMs)`. Sort: `time-desc` (default), `time-asc`, `ppm-desc`, `ppm-asc`; pageSize 1–50. Returns `{items, nextCursor}`. |
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
(only after STATUS handshake), `reason`, `bindingError`, `liveStorageError`, `permissionsGranted`, `lastSample`,
`sampleAvailable`, `nowElapsedMs`, negotiated `info`, and correlated `status`.
`connectionId` identifies the physical attempt; `reconnecting` marks a live native retry cycle.
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
clears it. The bounded preview cache holds only one immutable sample in RAM;
native persistence below is separate from UI availability and never uses IndexedDB.

## Autonomous native LIVE_SAMPLE storage

After protocol validation, `SensorBleService` captures `System.currentTimeMillis()`
at its native LIVE_SAMPLE callback, before dispatching to main. Main admits only
the current connection/run in READY with matching handshake bootId and captures
that session's Info deviceId into an immutable `NativeLiveSample`. Its `measured_at`
is the phone's calendar receipt time, not the sensor's acquisition time and not
derived from elapsedRealtime. Transport/dispatch latency and phone clock changes
can affect this receipt time; uptime remains a separate exact field.

`BleServiceRuntime` owns one process-wide `LiveSampleWriter`. All helper creation,
database opening, queries and transactions run on its single disk thread, outside
the BLE loop and main looper. `AndroidLiveSampleStore` uses the platform
SQLiteOpenHelper without an additional dependency. Its database is
`noBackupFilesDir/live-samples-v1.db`, separate from bindings and WebView data;
it survives app restarts/updates but is excluded from backup and lost on uninstall
or app data clearing.

The `live_samples` table stores a generated measurement UUID, deviceId, bootId,
sampleCounter, uptimeMs, ppm, measured_at and source=`sensor`. Both uint64 fields
are canonical decimal TEXT, never signed SQLite integers or JSON numbers.
One transaction checks and inserts the unique `(device_id, boot_id, sample_counter)`
identity. A duplicate with matching ppm and uptimeMs preserves the original UUID
and receipt time. A different ppm or uptimeMs is a conflict; failed opens/inserts
and conflicts are not acknowledged as duplicates or silently overwritten.

Accepted queue entries retain their captured device identity across disconnect
and subsequent sessions. Normal disconnect keeps the foreground service until
its queue barrier completes; it does not cancel accepted writes. Destroying the
Activity/WebView does not own or shut down the queue. The last storage failure
is logged and remains in `getState().liveStorageError` across subsequent reads,
successful writes and new sessions within the process. Reading this field does
not perform disk IO. The shared Android history UI uses the read-only reader below.
There is no HTTP upload, automatic process/boot startup,
automatic retry of failed receipts, retention pruning or gap recovery in this path.

Commit is the durability boundary: process death before commit can lose an
accepted in-memory receipt, and LIVE_SAMPLE has no durable delivery ACK/replay.
Screen-off operation still depends on Android keeping the existing foreground
connection alive. The existing journal cancellation rules above remain unchanged.

### Reading history without a BLE service

The same **Von**, **Bis**, **Verlauf anzeigen**, sortable Zeit/CO₂ headers and
**Weitere laden** controls use `BleService.getLiveHistory` on Android. Browsers
continue to use GET /api/measurements. Android renders the saved phone receipt
time; neither sensor uptime nor page-load time replaces it. The native result
contains measurementId, deviceId, bootId, source, ppm and measuredAtMs (decimal
calendar milliseconds). No sensor uint64 is converted into a JavaScript number.

`AndroidLiveSampleHistory` opens the existing database with OPEN_READONLY on its
own serial worker, separate from both main/GATT and the write queue. An absent
database returns an empty page without creating it. Existing unreadable or
incompatible databases reject the bridge call; the UI shows the storage error.
No schema version, rows or writer behavior is changed.

SQLite applies the whole `[from, to)` filter and ORDER BY before LIMIT. Time sort
uses `(measured_at, rowid)`; ppm sort uses `(ppm, measured_at, rowid)`, with every
key in the selected direction. The unique rowid breaks ties without OFFSET.
The first page captures MAX(rowid); subsequent pages exclude later inserts and
use a keyset cursor bound to period, optional device filter, sort and page size.
Reloading/filtering/sorting starts a new snapshot and clears the old cursor.
Only the requested page plus one look-ahead row is returned by the SQL query.

`AndroidLiveSampleHistoryTest` exercises real SQLite in the isolated target:
missing/empty and populated history, exact receipt boundaries, four sorts over
multiple pages with ties, concurrent inserts between pages, cursor validation,
read errors and unchanged database bytes. UI tests cover the Android bridge,
stale replies, local errors, common controls and the unchanged browser HTTP path.

History verification on POCO 2412DPC0AG (2026-11-11): all six new
`AndroidLiveSampleHistoryTest` cases passed on real SQLite (**0.273 s**), and
18 targeted Angular UI/data-access tests passed. The updated main debug app was
then checked with the existing 120 sensor receipts, no BLE service and no adb
reverse mapping. No backend was started. In each of the four UI sort directions,
**Weitere laden** returned pages **50 + 50 + 20**; all IDs in the displayed order
matched a read-only SQLite snapshot. Header arrows/aria-sort changed correctly,
the empty future period showed no rows, and a fresh WebView reload still loaded
the history after disconnect. Observed history HTTP calls: **0**. The main
database's SHA-256 was identical before and after these checks. Temporary WebView
inspection hooks/forwarding were removed; no test rows were added to the main DB.

Targeted tests: `LiveSampleAdmissionTest` and `LiveSampleWriterTest` cover session
fencing, captured identity/calendar time, exact uint64, serial writes, graceful
queue drain and surfaced write/open failures. `AndroidLiveSampleStoreTest` in
`app/src/androidTest` uses real SQLite in an isolated target-app noBackup subdirectory
and covers reopen/reconnect duplicates, new boots/devices, uint64 TEXT, content
conflicts and transaction rollback/retry. Run that class on a device/emulator;
JVM tests alone do not execute Android SQLite. The class requires target package
`de.lueftlotse.app.sqlitetest` before it creates any directory. Build that variant
with a temporary Gradle init script setting debug applicationIdSuffix to
`.sqlitetest` and the app buildDirectory to a temporary directory. Install only
those isolated target/test APKs with `adb install -r`; the runner is
`de.lueftlotse.app.sqlitetest.test/androidx.test.runner.AndroidJUnitRunner`.
Do not run this class against the main package. Each test owns a fresh random
child directory of the isolated target's noBackup directory, and cleanup does
nothing if setup failed before creating that directory.

Manual screen-off check (separate from automated tests): establish a connection
from the visible app, background it so no UI reader polls, turn off the screen,
wait for several samples, then inspect native row count/keys and receipt times.
Record screen-off/keyguard times using the phone clock so samples before/after
locking do not count as evidence. After **Trennen**, wait for SensorBleService to
stop and drain accepted writes. Copy the database and any journal/WAL sidecars
via `run-as` without modifying the phone files; query only the local copy with
SQLite `mode=ro` and `PRAGMA query_only=ON`. An unrelated WebView service is not
the BLE service. Do not infer a successful background check from compilation,
mocks or total row growth alone.

### Recorded POCO verification — 2026-11-11

Device: POCO model **2412DPC0AG**. All six `AndroidLiveSampleStoreTest` tests passed
on real Android SQLite: **OK (6 tests), 0.128 s**. These cover reopen/reconnect
deduplication with the original UUID/time, independent boots/devices, maximum
uint64 TEXT values, separate ppm/uptime conflicts, and failed-insert rollback
followed by retry. The isolated target noBackup directory was empty after cleanup.
The targeted JVM checks had also passed (37 scenarios across admission, writer,
service state and binding actions); they were not rerun for the device experiment.

The main debug APK was then installed as an update of `de.lueftlotse.app`, without
uninstalling or clearing data. The installed APK hash matched the built APK.
Initially `live-samples-v1.db` did not exist. The user connected the real sensor,
backgrounded the Activity and locked the phone, then used notification **Trennen**
after waking it. USB remained connected and the phone was powered. No backend
or adb reverse was started/configured for this check; the native writer uses no
HTTP upload. Forced idle and automatic reconnect were not used.

MainActivity pause/stop events preceded the measured locked interval, so the UI
reader was inactive. Read-only ADB observations of screen state, keyguard and
foreground service state ran from the host. A conservative interior interval
was selected from consecutive confirmed screen-OFF + keyguard observations;
maximum observation spacing inside it was 1.264 s. All 49 service observations
inside that interval showed foreground operation. Times below are **CET (UTC+01)**,
using the phone's calendar clock; intervals include the start and exclude the end.

| Receipt-time interval | Persisted rows |
| --- | ---: |
| 11:49:07.037–11:57:48.565 (521.528 s confirmed locked/screen-off interior) | 109 |
| 11:49:07.037–11:52:07.037 (first three minutes inside that interval) | 38 |

The final snapshot contained **120** rows: **6 before**, **109 inside**, and
**5 after** the full interval. The first/last receipts inside it were
11:49:07.210 / 11:57:47.479. Every row had source=`sensor`; there were no duplicate
identity keys. After Trennen and BLE-service shutdown, the database plus journal
were copied and inspected locally read-only: `PRAGMA quick_check` returned `ok`.
No LIVE_SAMPLE storage errors appeared in the captured service log.
Database copies, APKs and raw logs are local verification artifacts, not repository
contents.

This verifies one connected screen-off run with an inactive Activity reader;
it does not establish survival of process death, destroyed WebView, force-stop,
unplugged/battery operation, prolonged deep Doze or every OEM power policy.

## Verification and limits

From `frontend/android`, with the existing JAVA_HOME (JDK 21) and ANDROID_HOME:

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
gate, not Android framework dispatch. Beyond the recorded POCO run above,
permission edge cases, Activity recreation, deep Doze and radio-loss behavior
still need device testing. An FGS improves process priority;
it does not guarantee unlimited execution or survival of force-stop, process
kill or OEM power management. There is no wake lock or process/boot restart loop.

Successful reception does not establish measurement accuracy. The SCD41 in this
prototype previously had isopropanol on its membrane; its accuracy remains
unverified, as described in the [frontend documentation](../README.md#simulator-tests-and-prototype-accuracy).
This is a limitation of our sensor, not of LIVE_SAMPLE or the BLE protocol.

## POCO reconnection verification (2026-11-16)

On USB/ADB-connected POCO 2412DPC0AG, with ESP32 manually power-cycled and
no backend involved, the screen was confirmed off/keyguard locked from
13:06:19.930 to 13:12:29.739 CET. After GATT status 8, retries used
1/2/4/8/16/30-second delays and repeated the handshake for the same deviceId.
SQLite contained 22 receipts with a new bootId inside that locked interval,
starting at 13:10:45.951 CET; receipts after unlocking were excluded.
No LIVE_SAMPLE storage errors or duplicate keys were found.

Notification Trennen was tested both during a connection attempt (cancelled)
and while a 30-second retry timer waited. The saved log confirms that the timer
was scheduled at 13:24:59.837 CET; its next attempt was due at 13:25:29.837 CET.
After the user pressed Trennen in the notification with ESP32 still off, service
absence was observed at 13:25:24.472 CET, before that deadline. The scheduled
attempt never started; the binding read confirmed revision 18 and
connectionEnabled=false.

After the user confirmed ESP32 was switched on again, the phone-time observation
interval was 13:27:34.148–13:28:38.315 CET (**64.167 seconds**). The continuous
service log contained **zero BLE attempts** in that interval; all six periodic
service observations showed the service absent. This completed the hardware
timer-cancellation test, separately from cancellation of an in-flight attempt.
These logs were rechecked after the visible-app-startup change; this earlier
hardware run preceded that change and was not repeated on the updated APK.
The read-only SQLite snapshot contained 1937 rows; the final receipt preceded
the outage. Earlier rows were preserved. These observations concern a live
service on USB power, not process/boot restart, unplugged battery operation or
prolonged deep Doze. Raw logs/database copies stay outside the repository.

## POCO visible-app startup verification (2026-11-16)

The updated main debug APK (`de.lueftlotse.app`, not the isolated SQLite test
package) was installed with `adb install -r`; app data was not cleared.
With the phone unlocked, ESP32 available, existing grants and saved enabled
intent, the app process was force-stopped only to exercise a cold opening.
Opening MainActivity then connected without selection: state reached ready,
Info deviceId matched the saved UUID and fresh CO2 was displayed. No direct
bridge start command was injected; only normal app opening triggered startup.

Returning from the launcher while already connected preserved both logical
runId and physical connectionId, with the sample counter advancing. After
Trennen through the normal UI button, revision 20 retained the saved identity
with connectionEnabled=false. Another cold opening stayed stopped with no owner
and an enabled Sensor selection button. Earlier notification Trennen had also
persisted false (revision 18), and opening the updated app did not reconnect.
UI and native state were inspected through the debug WebView; the OEM blocked
ADB key injection, so launcher transitions used Activity intents. No security
settings were changed. SQLite snapshots were taken only after service shutdown,
read locally in read-only mode and passed quick_check; raw artifacts remain
outside the repository. Missing-grant and forgotten-binding startup guards were
covered by targeted tests, without revoking real phone grants or deleting its
real binding. No backend or adb reverse was used for these checks.

## Native CO2 episode warning

Only validated LIVE_SAMPLE receipts of the current READY session feed the native
alert queue, after submission to the unchanged SQLite writer. The independent
serial queue uses application context and elapsedRealtime; neither WebView,
calendar time, HTTP nor PostgreSQL participates. It never injects measurements.

A warning requires consecutive fresh receipts at **2000 ppm or above for at
least 30000 ms**. The receipt at/after the boundary must confirm it; no timer
alone can fire an alert. A gap of **15000 ms or more**, stale queued delivery,
sensor measurement error, disconnect or fresh value below 2000 resets the
unfinished countdown. Freshness is checked against processing time as well as
receipt-to-receipt gaps, so sleeping/delayed handlers cannot bridge stale data.
An epoch invalidates queued receipts on interruption. Duplicate counters in the
same boot do not refresh the countdown. A new boot resets an unfinished countdown.

One warning is allowed per device episode. Only a fresh value **below 1800 ppm**
rearms it; 1800 itself and values in 1800-1999 do not. Disconnect, reconnect and
ESP32 boot changes do not rearm. The warned latch is atomically stored separately
per deviceId in no_backup/co2-alerts-v1/<uuid>.state, before notification delivery,
and survives Trennen and process recreation. The monotonic countdown itself is
not persisted. All latch IO runs on the alert queue, not BLE/main or SQLite queues.
Unreadable latch state fails closed and is logged, without changing measurements.

The separate high-importance channel is **co2_high_v1** (CO2 warnings), notification
ID **4102**; the ongoing Sensor connection notification remains ID **4101** with
Trennen. App permission and the alert channel setting are checked independently.
If permission is denied, no notification is attempted and no warned latch is
consumed; a later permitted fresh high receipt may confirm the existing duration.
A permission race or notification exception after the latch commit is logged and
conservatively consumes the episode, avoiding repeated attempts; delivery is not
guaranteed by the OS. Notification errors never cancel BLE or SQLite recording.

Automated verification uses synthetic JVM receipts: 30-second boundary, short spike,
15-second freshness boundary, delayed delivery, disconnect, duplicate counters,
new boot, no repeats, fresh <1800 rearming, recreation of persisted latch state,
denied notification permission and isolated notification/storage errors. These
fixtures are not real sensor measurements and are not written to the phone DB.
The targeted run passed 33 app JVM tests (10 episode policy, 3 alert queue,
5 permissions, 11 reconnect and 4 live-writer cases), plus 33 Android-facade
UI tests. Debug Java compilation and git diff --check passed; no full suite,
production web build or APK packaging was required for this change.

### POCO notification delivery with synthetic samples (2026-11-16)

This experiment tests Android notification delivery on a real POCO with
**synthetic 2200 ppm values**, not real SCD41 measurements or sensor accuracy.
Only the separate package `de.lueftlotse.app.co2test` was installed. A temporary
Gradle init script changed its application ID/build directory and compiled a
temporary Java copy with test-only arming/generation controls. The repository's
release sources contain no synthetic entry point. The temporary init script
rejects release tasks; APKs, copied sources, logs and snapshots stay outside Git.

The five production alert-handler/runtime files were verified byte-identical
before building. The isolated copy of SensorBleService uses its original
foreground-notification builder (ID 4101, Trennen); its test-only branch feeds
`BleServiceRuntime.co2Alerts(...).sample(...)`, the same handler as real receipts.
It bypasses GATT and the SQLite writer entirely. The probe Activity is native,
without a WebView; no backend or adb reverse is used. Normal service/GATT startup
is not exercised by this injection harness.

After the user locked the phone, a test-only receiver started 14 synthetic
receipts at real elapsedRealtime intervals, spanning **65091 ms** with a maximum
gap of **5010 ms**. The confirming seventh receipt arrived at **30039 ms**.
There were zero alert records in 22 pre-threshold observations. The production
sender logged exactly one post at **30061 ms**; Android held alert ID 4102 on
`co2_high_v1`, alongside ID 4101 with its Trennen PendingIntent. There were no
further posts through the remaining high samples and no alert-processing errors.

All 50 observations during the series showed keyguard locked and Dozing.
SCREEN_STATE_OFF was confirmed at delivery; ten observations elsewhere in the
series showed brief SCREEN_STATE_ON while still locked/Dozing. Thus this is a
locked-phone delivery test, not a claim of uninterrupted physical screen-off
state throughout. NotificationManager records confirm OS delivery and retention
of the Trennen action. The user subsequently reported that neither notification
was visible on the lock screen. Therefore visual lock-screen presentation and
user access to Trennen there have **not passed** verification; active OS records
alone do not establish that the user can see or operate them.

Read-only follow-up found POST_NOTIFICATIONS granted, alert importance HIGH,
mHidden=false, mIntercept=false and no suppressed visual effects. Both general
lock_screen_show_notifications and lock_screen_allow_private_notifications were
1; channel lock-screen visibility inherited the system default. The exact cause
of the missing UI presentation is not established. Per-app HyperOS lock-screen
and Always-on-display settings remain possible factors, not a confirmed cause.
No settings were changed. Visibility in the unlocked notification shade still
requires a separate user check.

The test package's no_backup contains only the separate episode-latch file;
no history database was created. SHA-256 values of the main package's existing
measurement DB and binding file were unchanged before/after; its APK update time
also remained unchanged. Its app data and permissions were not modified. The
previously successful automated tests were not rerun for this hardware experiment.

A user-requested repeat used an updated isolated probe only: it first submitted
a fresh synthetic 1700 ppm receipt through the same alert handler to rearm, then
started another synthetic 2200 ppm series without deleting latch/history data.
At 15:58:52.566 CET one alert post was logged, 30059 ms after the new series
started. Android observations briefly contained both IDs 4101 and 4102, then
only 4101 again about four seconds later. The phone was unlocked for this repeat;
it does not establish lock-screen visibility. The user confirmed seeing and
tapping the repeated alert; its subsequent disappearance is consistent with
the sender's setAutoCancel(true). Visual presentation on the unlocked phone is
therefore confirmed for synthetic values; lock-screen presentation remains
unconfirmed after the earlier negative report. Main/release
sources were unchanged; the repeat entry remains only in temporary test sources.

A further locked-phone run used the **already installed** isolated APK, without
rebuilding or rerunning automated tests. Its installed command combines a fresh
synthetic 1700 ppm rearm receipt with immediate start of the high series; after
this constraint was explained, the user confirmed the screen was locked and
authorized starting that combined command. ADB confirmed SCREEN_STATE_OFF and
keyguard before the command; no unlock or settings change was performed.

The high series began at **17:07:00.168 CET**. Fourteen synthetic 2200 ppm receipts
spanned 65091 ms. The confirming receipt arrived at 30050 ms and exactly one
alert post was logged at **30083 ms** (17:07:30.251 CET). Twenty-two observations
before 29 seconds contained only the service notification; no earlier alert post
was logged. Both IDs were then present. All 50 observations during the series
showed keyguard locked, with the service notification and its Trennen action
retained; 27 showed SCREEN_STATE_OFF, the rest brief screen-on states while
still locked. No alert-processing errors or repeated posts occurred. Actual
lock-screen visibility was requested from the user separately and is not inferred
from these OS notification records.

The isolated no_backup contained its binding and episode-latch files, with no
measurement database. The main app's binding checksum remained unchanged, but
its measurement DB checksum changed during this run while its own BLE foreground
service was active. Thus unchanged main DB bytes cannot be claimed for this run.
Only read-only checks were made against that package; it was not started, stopped,
updated or given synthetic data by the experiment. Synthetic receipts were sent
only to the isolated package's alert handler, without its SQLite writer.

### Dynamic notification text: 2000 / 2100 ppm probe

Only the isolated debug APK was rebuilt/updated with the production sender's
new body template, `CO₂ ist erhöht: {ppm} ppm`. The unchanged title remains
`Lüftlotse: Bitte lüften`. Five production alert/runtime source files were checked
byte-identical in the temporary build. Its test-only controls now separate RESET
(one fresh synthetic 1700 ppm receipt) from a series with a selected 2000 or
2100 ppm value. No release test entry, SQLite write or threshold change was added.

The first start failed before any high receipts: a duplicate test ARM command
recreated the probe after RESET, losing its in-memory readiness flag and causing
`Rearm and valid ppm required`. The same installed test APK was restarted while
keyguard remained locked, then RESET was repeated immediately before starting.
This is a probe startup failure, not a failed 30-second threshold assertion.

The completed **2000 ppm** series contained 14 synthetic receipts over 65096 ms.
No alert was recorded before the threshold; exactly one post occurred at 30069 ms.
Android's stored title was `Lüftlotse: Bitte lüften` and body was exactly
`CO₂ ist erhöht: 2000 ppm`. Keyguard stayed locked in every observation and the
test service notification retained Trennen. The user explicitly confirmed that
both title and body were visible and correct on the locked phone, without
tapping the notification. A separate 2100 ppm series was then started after
another fresh synthetic 1700 ppm reset; its result is recorded separately.

The separate **2100 ppm** series also contained 14 synthetic receipts, spanning
65087 ms. There were no pre-threshold alerts; exactly one post occurred at
30064 ms, with no repeats or alert-processing errors. Android's title remained
`Lüftlotse: Bitte lüften`; its body was exactly `CO₂ ist erhöht: 2100 ppm`.
This confirms that the compiled sender substitutes the triggering receipt's ppm
rather than a fixed 2000. Keyguard remained locked in every observation and the
service notification retained Trennen. The user explicitly confirmed that this
second title/body were also visible and correct on the lock screen, without
tapping the notification. Both 2000 and 2100 ppm text checks therefore have
separate OS-record and user-visible confirmation.

After both series the isolated package had binding/episode-latch files only,
with no measurement SQLite database. The main package and phone settings were
not modified. These are real-phone delivery checks with synthetic receipts,
not real SCD41 measurements. No automated tests, commit or push were performed
as part of this on-device text check.
