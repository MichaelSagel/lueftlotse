# Mobile

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.2.

## Current CO2 display: Sensor

The normal UI shows Sensor only: no source picker, simulation controls or
automatic simulation. Until a new LIVE_SAMPLE after a successful BLE STATUS
handshake, the current reading is **—**. The device must
advertise Info v1.1 with capability 0x0010. Disconnect, unsupported preview or
15 seconds without a new valid sample shows **Sensor nicht verfügbar**, with no
automatic fallback. Reconnect requires another handshake and a new sample.

The German labels are **CO₂-Wert akzeptabel** below 1000 ppm, **Bitte lüften**
at 1000–1999 ppm, and **Hoher CO₂-Wert** with **Bitte lüften** from 2000 ppm.
These display thresholds do not create Android notifications.

Sensor preview is only the current reading: it does not enter IndexedDB, the
chart/history or HTTP synchronization. **Journalmessungen herunterladen** remains
a separate manual operation for persistent journal records. Existing history,
including earlier simulator records, remains available for viewing and manual
synchronization. The page and DeviceDiscovery share the same route-scoped BLE
session. Collapsing discovery preserves it. This Angular path still disconnects
on backgrounding; automatic connection/reconnect is not implemented. The opt-in
native service foundation below is not selected by the UI.

## Shared BLE session contract

The page's Co2Monitor, DeviceDiscovery and BleJournalSync consume `BLE_SESSION`.
The route aliases it with `useExisting: BleConnection`: there is still one working
implementation, one GATT connection and one Events assembler. No native service,
binding migration, reconnect or notification feature is enabled by this boundary.

UI commands use revocable clients. A manual journal run owns an exclusive lease;
each fetched packet has a token tied to the connection generation, client and
lease. Released clients/leases and old packet tokens cannot issue later commands.
Control writes are serialized separately from response waits. A packet's commit
callback resolves only after the existing atomic IndexedDB transaction completes;
only then can ACK be written. The next FETCH requires the matching ACK_ACCEPTED
and completion of the ACK write. LIVE_SAMPLE remains outside this path.

Cancellation, history clear and scope disposal revoke outstanding journal work.
An idle lease can be released while retaining the connection; cancelling a request
or an unconfirmed packet closes the connection because this implementation does
not implement CANCEL_BATCH. Already committed records remain stored. Late commit
completions and GATT callbacks cannot ACK or disturb a subsequent connection/run.

## Java BLE core, GATT transport and opt-in Android service

[`android/ble-protocol-core`](android/ble-protocol-core/README.md) contains the
Android-independent Java codec and protocol session for a single native
GATT owner. JVM tests use the shared binary vectors and cover generations,
bounded queues, handshake, LIVE_SAMPLE and commit-token → ACK → ACK_ACCEPTED.
All uint64 bridge values are decimal strings. The native service depends on it
through the transport; the Angular `BLE_SESSION` implementation and IndexedDB
binding owner are unchanged.
Its README documents the future transport/commit contracts and test/compile
commands that do not package APKs.

[`android/ble-gatt-transport`](android/ble-gatt-transport/README.md) adds an isolated
Android GATT owner for that core: sequential discovery/Info/CCCD/handshake, finite
callback deadlines, cancellation and generation checks. Fake-boundary JVM tests
exercise it without a radio.

The [Android service foundation](android/BLE_SERVICE.md) adds an explicitly started
`connectedDevice` foreground service and local `BleService` Capacitor plugin.
It owns the native transport independently of Activity/WebView and exposes state
and an in-memory LIVE_SAMPLE with its original monotonic receipt time. A quiet
German service notification has **Trennen**. A native ownership guard rejects a
second connection across the existing plugin and the service. The installed BLE
plugin still executes the existing UI's operations; Angular does not start or use
the new service. Auto-start/reconnect and CO₂ alerts are not implemented.
LIVE_SAMPLE is not persisted by either path.

The [manual native journal bridge](android/BLE_JOURNAL_BRIDGE.md) provides one
WebView lease, bounded BEGIN/ENTRY/END events and an explicit commit-token gate.
The optional `NativeBleSession` implements `BLE_SESSION`, but is not selected by
the working route. `BatchReceiver` and the atomic IndexedDB commit remain in
TypeScript; ACK follows commit, and the next FETCH follows matching ACK_ACCEPTED.
The service stores neither journal data nor a cursor and revokes an unavailable
WebView's lease. This addition does not activate binding migration.

The [native binding migration](android/BLE_BINDING.md) is now implemented as an
explicit operation. It is not invoked on startup or by the normal UI. It freezes
the old IndexedDB writer, confirms an atomic native commit, then removes the old
record. Native state (including a permanent empty/forgotten marker) is authoritative
after migration; Angular reads it via `BleService`. Legacy BLE connects are then
blocked until the UI is integrated with the native service. Backup rules exclude
WebView data, including the old binding, and the native file is in noBackupFilesDir.
This also excludes history from Android backup and phone transfer: it remains
locally across normal updates, but is not restored after uninstall/reinstall or
on a new phone. Backend upload currently has no matching history-restore path.
The migration document explains this storage limitation and the exact rules.

## Remembered BLE sensor

After a successful STATUS handshake (including completion of its Control write),
the app remembers one sensor: the UUID from Info, the BLE address supplied by the
Android adapter, and `connectionEnabled: true`. This flag records connection intent
for a future auto-connect feature; it does not currently initiate any connection.
The saved sensor can be connected explicitly with **Verbinden**, without a scan.

Every later connection must match the saved Info UUID. A mismatch closes the
attempt without replacing the binding; choose **Gerät vergessen** before selecting
a different sensor. The same UUID at a new address updates that address only after
another successful handshake. **Trennen** closes the session and persists disabled
intent, even when already disconnected. Backgrounding, radio loss, scope cleanup
and journal failures close the transport without changing this intent.

**Gerät vergessen** closes the session and removes the binding. It leaves history,
journal cursors and pending backend synchronization intact. Forgetting and changing
devices are disabled during a manual journal download; cancel the download first.
Storage errors are shown explicitly; a failed write is not reported as a saved
binding, and unreadable/unsupported settings are never silently overwritten.

Before explicit migration, the binding is a versioned record in the separate IndexedDB database
`lueftlotse-device`, store `settings`, key `ble-binding`. It survives normal app
restarts in the same app/WebView origin. Clearing app/site data or uninstalling
can remove it; it is not Android Bluetooth pairing or a native service preference.
Clearing measurement history does not remove it. No LIVE_SAMPLE values, bootId,
sampleCounter or uptimeMs are stored in this record.

Tests recreate the application injector against the same fake IndexedDB to check
restart persistence, UUID rejection, explicit disconnect/forget, late callbacks,
pending writes and storage failures. Actual Android process-restart persistence
still requires a device check when an APK is prepared.

## Simulator tests and prototype accuracy

`Co2Simulator` and the replaceable `CO2_SOURCE` token remain available for tests.
The normal route supplies an inactive source with no readings for Co2History;
it does not instantiate the simulator or connect preview to the history stream.
Tests that generate measurements explicitly provide Co2Simulator and bind
CO2_SOURCE to it (or supply a fake). Simulator generation and persistence remain
covered by tests.

**Accuracy limitation of our prototype:** isopropanol contacted the membrane of
our SCD41. Its measurement accuracy is unconfirmed; receiving data with valid CRC
does not establish accuracy. This limitation remains documented here, without a
Prototyp-Warnung on the main screen. It is not a BLE protocol property.

Run the complete web checks from `mobile/` (no APK preparation):

```text
npm test -- --watch=false
npm run build -- --configuration production
```

Hardware checks still needed in the Android app with compatible firmware:

1. Open the app: Sensor shows —, with no source picker, simulation controls or
   prototype warning. No simulation, scan or connection starts automatically.
2. Connect a device: the value stays — until a NEW sensor sample appears.
3. Interrupt notifications for 15 seconds or disconnect: the reading clears and
   unavailability is explicit. Reconnect waits for new data.
4. With journal-capable firmware, download journal records manually while viewing
   Sensor. Only canonical journal records enter history/backend, not preview.

See [BLE implementation notes](src/app/features/air-monitor/ble-protocol/README.md)
for session validation, timer and persistence boundaries. Browser tests use a fake
native adapter; real radio loss, Android lifecycle and SCD41 accuracy are not
established by these checks.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Local measurement synchronization

From the repository root, start the local API and Angular in separate terminals:

```text
dotnet run --project backend/src/Lueftlotse.Api
npm --prefix mobile start
```

The Angular development proxy forwards `/api/**` to `http://127.0.0.1:5045`.
The API stays on loopback; no CORS or Android cleartext changes are required.
Restart `ng serve` after editing `proxy.conf.json`.

API base URLs are configured in
`src/app/features/air-monitor/data-access/measurement-api.config.ts`.
The browser uses `/api`. Native release builds have no configured server (`nativeBaseUrl: null`)
and disable synchronization; the phone's localhost is not the development computer.

Open **Synchronisierung** and choose **Jetzt synchronisieren** to send pending
measurements, grouped by device and source, with at most 100 per request.
The run uses a fixed local key boundary so newly collected measurements wait for
the next manual run. Confirmed packets are marked synced in IndexedDB without
deleting history. Lost or invalid responses leave the packet pending; a later
manual retry sends the same measurement IDs and accepts server duplicates.
Errors stop the run; earlier confirmed packets remain synced. There are no
automatic retries. IndexedDB v3 adds a sync-status index while retaining v1/v2
history, primary keys, assigned IDs, metadata migration progress and simulator identity.

## Additional Resources

### Android USB debug synchronization

Use the installed Android SDK Platform-Tools and JDK 21. Set `JAVA_HOME` and
`ANDROID_HOME` only in the current terminal; no administrator rights are needed
when the phone's USB driver is already available. Enable USB debugging on the
phone and approve this computer.

From the repository root:

```text
npm --prefix mobile run android:prepare:usb-debug
cd mobile/android
cmd.exe /d /c "gradlew.bat assembleDebug -Pandroid.builder.sdkDownload=false --no-daemon --console=plain"
```

Start the backend on `http://127.0.0.1:5045` in Development using its existing
User Secrets. With `adb` from SDK `platform-tools` (or its full path):

```text
adb devices
adb -s <serial> reverse tcp:5045 tcp:5045
adb -s <serial> reverse --list
```

Install the debug APK manually, then use **Synchronisierung**. The app calls
`http://127.0.0.1:5045/api` through USB with native CapacitorHttp; Angular's dev
server, LAN exposure and CORS changes are unnecessary. Disconnecting USB can
lose a response: pending measurements keep their IDs and can be retried manually.
Remove forwarding with `adb -s <serial> reverse --remove tcp:5045`.

For release preparation use `npm --prefix mobile run android:prepare:release`,
then `assembleRelease` from `mobile/android` with the same Gradle flags.
Production assets always have no native API configured. USB assets are placed
only in the Android debug source set, along with the HTTP permission restricted
to `127.0.0.1`. Gradle checks web profile markers and the USB address before
debug/release builds, including direct Gradle invocations. A plain `cap sync`
without preparation intentionally fails these checks. Never copy USB assets
into `src/main`. Release signing is configured separately.

After building both APK variants, check the actual archives and manifests from
the repository root (requires `ANDROID_HOME` and Build-Tools 36.0.0):

```powershell
& ./mobile/scripts/verify-android-apks.ps1
node --test mobile/scripts/verify-android-assets.test.mjs
```


For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
