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
session. Collapsing discovery preserves it. Backgrounding still disconnects;
automatic connection/reconnect and foreground services are not implemented.

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
