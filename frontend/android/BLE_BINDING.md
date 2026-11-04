# Native binding and one-time IndexedDB migration

On Android, `NativeBleSession` is the route's only `BLE_SESSION`. It invokes
`NativeBleBinding.migrate()` when the first UI client attaches and awaits successful
migration before every explicit connection. Constructors have no IO. Failure
blocks connection and is reported in German; another explicit attempt can retry
the idempotent operation. No fallback transport is used. Browser sessions cannot
call the native bridge or migrate. Migration never starts the BLE service.

## One persistent owner

`NativeBindingRepository` owns one record containing a schema version,
`migrationComplete`, uint64 `revision`, and an optional binding with Info UUID v4,
Android BLE MAC address and `connectionEnabled`. Bridge revisions are canonical
decimal strings, including the full uint64 range; exhaustion fails without wrap.
There is no general-purpose bridge setter for an identity/address. A new native
binding or updated address is saved only after the core's correlated STATUS and
final Control write complete. The previously stored UUID and the revision captured
at start must still match. Info alone, mismatches and late callbacks cannot save.
Migration is the one-time import of the already validated legacy binding.

The file `noBackupFilesDir/ble-binding-v1.bin` is the only native source of truth.
It is a bounded, versioned binary record with a CRC; it contains no LIVE_SAMPLE,
measurement, journal cursor or backend state. Writes sync a sibling temporary
file, atomically rename it, sync the directory and verify the resulting bytes.
A leftover temporary file is never read as committed data. Reads also sync the
directory to confirm a replacement whose prior acknowledgement may have failed.
No SharedPreferences cache or optimistic in-memory value acts as confirmation.
Only a missing file means not migrated; IO, size, version, CRC and schema errors
are reported explicitly and never turn into an empty binding.

An absent file returns `{migrationComplete:false, revision:"0", binding:null}`.
Successful empty migration writes `{migrationComplete:true, revision:"1",
binding:null}`. That persistent marker is distinct from absence. Forget writes
another empty migrated record; it never deletes the file or resets the revision.
Repeated migration returns the current native snapshot without importing the
candidate again, even if an old IndexedDB record names a different sensor.

## Bridge and migration ordering

The local `BleService` plugin exposes:

| Method | Contract |
| --- | --- |
| `getBinding()` | Read a confirmed snapshot. Reject unreadable/corrupt storage. No initialization/migration/write. |
| `migrateBinding({binding})` | Import `{version:1, deviceId, bleAddress, connectionEnabled}` or explicit null once. Requires an idle ownership slot for the first import. After completion return current native state, ignoring old candidates. |
| `forgetBinding({revision})` | Compare the decimal revision, persist an empty migrated record, close the native session. An old revision cannot forget or close a newer session. |
| `disconnect({runId})` | Persist disabled intent, then close that run. The same run token can disable intent after radio loss; a token from an older run has no effect. |
| `disconnect({revision})` | When the process has no run, compare the binding revision and disable saved intent. Cannot affect a current/newer run. |

`NativeBleBinding.migrate()` is the only coordinator for deleting the old record:

1. Read native state through the bridge. A read failure stops the operation.
2. If not migrated, use one IDB transaction to read/validate the old record and
   set `settings["ble-binding-native-owner"] = true`. Every legacy write/remove
   checks this key in its own write transaction, so a concurrent page cannot
   overwrite the migration candidate. Invalid/unreadable data aborts the transaction.
3. Import through BleService and await a valid completed native snapshot.
4. Only after that acknowledgement, use one IDB transaction to delete
   `settings["ble-binding"]` and retain the writer marker. The DB is still
   `lueftlotse-device`, version 1; no history database is changed.
5. Re-read native state for Angular; the candidate is never published as an
   independent copy of the canonical binding.

If native state was already migrated at step 1, skip reading/importing legacy
data and finish its deletion. An interrupted migration can be explicitly resumed:

| Interruption/error | Retry behavior |
| --- | --- |
| Before native commit | Old record stays. A prepared IDB writer fence stays set; retry reads the same candidate. |
| Native replacement completed, bridge reply lost | Read native marker on retry, skip import, finish IDB deletion. |
| Native commit confirmed, IDB deletion failed | Native state stays authoritative; retry deletion, never roll back or re-import. |
| IDB deletion completed, final read/reply failed | Read native state again; repeated deletion is harmless. |
| Forget followed by an old migration request | Native tombstone wins; the old device cannot be restored. |

Before migration ordinary IndexedDB IO remains local and does not call
the native bridge. After the writer fence, legacy reads go through BleService;
while migration is pending they report that explicit resume is required. Legacy
write/remove never silently fall back. Service start requires the completed native
marker. The old plugin rejects all GATT methods regardless of migration state.
Migration does not open GATT, request permissions, connect, fetch or ACK anything.

`NativeBleBinding.refresh()` reads native state; `forget()` calls the native
revision-checked operation and only then removes any leftover legacy record.
If forget is the first operation before migration, it first fences the old writer
in the same way as migration. Failed forget retains that fence for explicit retry.
Its state/error signals report storage failures. The selected Android session
uses this coordinator for migration, binding reads and **Gerät vergessen**.

## Disconnect, forget and failures

Service mutations run sequentially on the existing command queue. **Trennen**
awaits the synchronous durable disabled-intent write before initiating GATT
cleanup. IO failure still closes GATT in a finally block: the bridge rejects,
`getState().bindingError` retains the error through cleanup, and the notification
action shows a German error toast. An unsuccessful write is never reported as
saved; on retry the repository re-reads disk rather than trusting a stale cache.
No reconnection is scheduled.

**Gerät vergessen** persists a null binding with migrationComplete still true,
then closes/revokes the session, including a pending handshake. A storage failure
still closes and reports failure while retaining whatever was durably committed.
An old revision is rejected without closing a newer session. A process restart
reloads the native record; attaching the UI finishes any interrupted migration,
but does not trigger connection. A ready native run is only observed on reattach.

## Backup and reinstall

Native storage uses Android's
[`getNoBackupFilesDir`](https://developer.android.com/reference/android/content/Context#getNoBackupFilesDir()).
The native binding can therefore be excluded independently of history.

The legacy binding (`lueftlotse-device`) and history (`lueftlotse`) are logical
IndexedDB databases under the same WebView origin. Different JS database names
do not guarantee separate files: Chromium's LevelDB implementation stores several
IndexedDB databases in one backing store. WebView's internal layout can change;
Android backup XML selects files/directories, not an IndexedDB database, object
store or key. `domain="database"` refers to native database paths, not JS database
names. Reliably excluding only the legacy binding while retaining history is
therefore not possible with XML alone in the current storage architecture. See
the [Chromium backing-store description](https://chromium.googlesource.com/chromium/src/+/master/content/browser/indexed_db/docs/README.md)
and [Android backup rules](https://developer.android.com/identity/data/autobackup).

The manifest keeps `allowBackup="true"` and selects these exact rules:

- [backup_rules.xml](app/src/main/res/xml/backup_rules.xml), API 24–30:
  `<exclude domain="root" path="app_webview/" />` inside `full-backup-content`.
- [data_extraction_rules.xml](app/src/main/res/xml/data_extraction_rules.xml),
  API 31+ with this app's targetSdk: the same exclusion separately inside
  `cloud-backup` and `device-transfer`.

The entire WebView subtree is excluded, including history, sync metadata and
other WebView data. Narrowing the exclusion to the shared IndexedDB directory
would still exclude history. Other eligible application data remains eligible
for backup. These rules take effect only in an APK that contains them.

| Scenario with these rules | History outcome |
| --- | --- |
| Restart or APK update without clearing app data | Local history remains; backup rules do not delete it. |
| Uninstall followed by reinstall | Local history is removed and is not restored by standard Android backup. |
| New phone via Android cloud restore or device-to-device transfer | History is not transferred. It remains on the old phone until its data is removed. |

The native binding and the old WebView binding are not automatically restored
through these mechanisms. Already uploaded backend records are unaffected, but
`Co2Sync` currently only uploads: the app has no backend history-download/restore
path. Manual BLE journal download is not a backup of the entire phone history.
Local-only history has no recovery path after uninstall unless another copy exists.

Preserving history backup requires a separate implementation, such as a versioned
history snapshot or native database outside WebView, with an explicit restore
path that excludes all binding data. This stage does not implement that feature.

## Checks

JVM tests cover empty/one-time migration, restart, interruption before/after
replacement and read-back, corruption/read errors, revision exhaustion, identity
mismatch, forget, pending/stale STATUS, save-before-close ordering, storage failure
cleanup and manifest backup exclusions. Frontend tests use real fake-indexeddb
transactions and a fake bridge to test fencing, native acknowledgement before
deletion, every retry boundary, empty state, forget and reading through the bridge.
The full frontend suite also checks that the existing BLE/session/journal path works.

Run `npm.cmd test -- --watch=false` in `frontend`. With the installed JDK 21 and SDK,
run in `frontend/android`:

```powershell
./gradlew.bat :ble-protocol-core:test :ble-gatt-transport:testDebugUnitTest :app:testDebugUnitTest :app:compileDebugSources :app:compileReleaseSources '-Pandroid.builder.sdkDownload=false' --offline --no-daemon --console=plain
```

These targets do not package an APK. JVM fakes do not simulate Android filesystem
power loss or actual restore; process-kill, reinstall/backup and notification
error display still require a later authorized device test.
