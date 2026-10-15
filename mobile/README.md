# Mobile

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.2.

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
