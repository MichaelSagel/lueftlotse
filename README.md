# Lüftlotse

CO₂ monitoring with an ESP32/SCD41 sensor, an Angular/Capacitor frontend and a
C# API with PostgreSQL. Android and the browser share a single-column display
and history controls, but use separate Bluetooth, persistence and history paths.

## Android

Opening the app loads the native binding and checks permissions before starting
automatic connection. The service first tries the saved address, then searches
for the Lüftlotse BLE service in scan windows with increasing pauses capped at
30 seconds. Attempts do not run in parallel. Every handshake checks the saved
deviceId; another sensor is not silently bound. Without a binding, a single
advertiser can be connected automatically; multiple candidates pause discovery
and the current screen offers no selection UI.

The main screen has no connection buttons or BLE-device list. During discovery
the CO₂ card shows **Sensor wird gesucht …**. Pulling down from the top refreshes
connection intent, resumes an idle search and retains an active/searching run.
A small circular indicator accompanies the gesture.

`SensorBleService` receives and saves validated LIVE_SAMPLE independently of
Activity/WebView, including while the screen is locked as long as the service
continues running. Native SQLite in `no_backup/live-samples-v1.db` keeps receipts
for the last **8 × 24 hours**, using phone reception time. Background cleanup on
writable opening and at most hourly during recording deletes only older rows;
the exact boundary is retained. Errors are reported, and corrupt database files
are not automatically deleted or recreated. Normal app updates preserve data;
uninstalling/clearing storage does not. No HTTP or PostgreSQL is needed.

**Von**, **Bis**, **Verlauf anzeigen**, header sorting by **Zeit**/**CO₂ (ppm)**
in both directions and **Weitere laden** query SQLite, even without a BLE
connection or running BLE service. The period is [from, to); sorting covers the
whole period with stable pagination.

A native warning requires fresh measurements **≥2000 ppm for at least 30
seconds**, confirmed by another fresh receipt. Disconnects, stale data and a
value below 2000 reset an unfinished countdown. Only one warning is delivered
per episode; a fresh value **<1800 ppm** rearms it. Reconnection alone does not.
The warning uses its separate channel and actual triggering ppm. Denied
notification permission does not stop Bluetooth or SQLite recording.

The required foreground-service notification has no **Trennen** action and uses
`VISIBILITY_SECRET`; its absence from the POCO lock screen and continued recording
were checked. CO₂ warning visibility is independent and unchanged.

Guarded `START_STICKY`/null-Intent recovery is implemented for a migrated, enabled
saved binding with required permissions. **Recovery after SIGKILL on POCO is not
confirmed:** neither the main nor the isolated control service restarted. The
cause and behavior after other kinds of process termination are unknown. There
is no force-stop bypass or boot auto-start; open the app to resume a stopped run.
Missing measurements are not backfilled. A foreground service is not an
unlimited-execution guarantee.

See [Android service behavior and verification](frontend/android/BLE_SERVICE.md)
and [frontend setup](frontend/README.md).

## Browser

In a Web Bluetooth-capable browser on HTTPS or localhost, **Sensor auswählen**
opens the browser chooser; when connected the same button reads **Trennen**.
The browser does not use Android discovery or its foreground service.

Validated LIVE_SAMPLE notifications are saved atomically in IndexedDB with
source=sensor, a fixed MeasurementId and syncStatus=pending, then automatically
sent through the C# batch API to PostgreSQL. MeasuredAt is **browser reception
time**, not sensor sampling time. Deduplication by deviceId/bootId/sampleCounter
survives reconnect; HTTP retries preserve original IDs and data. Backend failure
leaves pending records locally. Disconnected gaps are not restored.

The visible browser history loads PostgreSQL through GET /api/measurements with
the same filters, sorting and pagination controls. It is separate from Android
SQLite and the browser's local upload buffer. There is no visible synchronization
panel or local-history table. See [browser persistence details](frontend/src/app/features/air-monitor/data-access/browser-live-samples.md).

For local browser development, run these commands from the repository root in
separate terminals after configuring PostgreSQL as described in the backend guide:

```text
dotnet run --project backend/src/Lueftlotse.Api
npm --prefix frontend start
```

The development proxy forwards /api to port 5045. Android's native recording and
local history require neither this backend nor adb reverse.

## Technical documentation

- [Frontend development and Android build profiles](frontend/README.md)
- [Backend setup and API](backend/README.md)
- [BLE protocol](docs/ble-protocol-v1.md)
- [Firmware and sensor setup](firmware/README.md)
- [Native binding](frontend/android/BLE_BINDING.md)
- [Internal journal bridge](frontend/android/BLE_JOURNAL_BRIDGE.md)

The prototype SCD41 membrane was exposed to isopropanol; measurement accuracy is
unconfirmed. A valid BLE packet/CRC is not evidence of sensor accuracy.
