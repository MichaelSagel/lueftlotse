# BLE v1 codec

Pure TypeScript implementation of `docs/ble-protocol-v1.md`. No Angular,
Bluetooth, IndexedDB or application state dependencies. SHA-256 uses Web Crypto.

## Shared session and native adapter boundaries

`../data-access/ble-session.ts` defines the application-facing `BLE_SESSION`
contract. On Android the route selects one `NativeBleSession`; Co2Monitor (the
page's preview), DeviceDiscovery and BleJournalSync all consume that instance.
Only BleService owns GATT. The browser implementation makes no native calls.
Read-only session
signals/preview are separate from `attachClient()` command capabilities.

Client IDs and lease IDs are opaque tokens. Each connection has a fresh generation
string, and each fetched packet a one-use ticket bound to that generation/client/
lease. Revoke a client on scope disposal; revoke a download through its AbortSignal
or lease. Late calls, queued writes and packet confirmations recheck ownership.
Old release/close callbacks cannot revoke another lease or close a new connection.
The Android service and one-time native binding migration are active; automatic
connection, reconnect and CO₂ notifications are not implemented.

`../data-access/ble-connection.ts` remains an explicit fake-adapter implementation
for protocol tests using the replaceable `BLE_ADAPTER` token. It awaits `BleScanner.stop()`,
initializes BLE, connects, reads/validates Info v1.0/v1.1, subscribes to Events, then
sends GET_STATUS and waits for the matching STATUS requestId. Production Android
uses the Java core for these checks through NativeBleSession instead. The route
shares BleScanner and BleJournalSync; child components do not shadow providers.
The UI shows progress and Info deviceId and requires explicit disconnect before
switching devices. Collapsing discovery preserves the connection. Scanning is
disabled during connection work and while connected; native scan admission and
confirmed stop also prevent scan/connect races.

In legacy protocol tests, `BleBindingStore` keeps one versioned Info UUID / native BLE address /
`connectionEnabled` setting in a separate IndexedDB database via the replaceable
`BLE_BINDING_STORAGE` adapter. Connection waits for settings to load, rejects a
different Info UUID before subscribing, and commits the binding only after the
matching STATUS and Control write complete. The same UUID may update its address
after a new successful handshake. Readiness is announced only after persistence
also succeeds. Neither settings restoration nor any disconnect starts BLE work.

`disconnect()` is transport cleanup and preserves intent; the UI's explicit
Trennen calls `disconnectByUser()`. `forgetDevice()` aborts the session and removes
the binding, without clearing history or journal cursors. Settings mutations are
serialized: an in-flight save finishes before disable/remove, and a cancelled
handshake cannot enqueue a new save. New connects are blocked until the explicit
action settles. Failed persistence still closes the transport and surfaces an
error. A failed remove retains disabled intent when that preceding write succeeds.
Unreadable records fail closed; explicit forgetting can remove a corrupt record.
These legacy implementation checks remain covered by fake-adapter tests. In
production the native repository is the sole binding writer after one-time
migration, confirmed before deleting the old IDB record. The native service
persists identity/address only after STATUS and UUID checks, disabled intent before
Trennen, and an empty migration marker before forget/close. See
[native binding](../../../../../android/BLE_BINDING.md) for storage failures,
retry rules and backup limitations. This is application selection, not
pairing/bonding; auto-connect remains absent.

Only Android is supported by the default adapter; browser connect rejects before
scanner/native calls. All known capability subsets are valid for this handshake;
there is no invented live/journal capability requirement for GET_STATUS.

One session owns one Events assembler and a Control ID allocator (0..65534).
STATUS requests remain serialized and bounded to four including the active one.
Journal ownership is exclusive. `controlTail` serializes complete Control writes;
the `requests` map owns response promises, independently of that queue. The separate
`statusTail` bounds/serializes ordinary STATUS requests. At most four exchanges
are active; a completed write never waits for its response inside `controlTail`.
Expected responses are registered before writes, and lease cancellation is checked
again immediately before every native fragment write.
Events IDs are independent. Request matching is installed before writing, and a
write response alone never establishes readiness. Unsolicited STATUS may update
status, but cannot complete a GET_STATUS request. Once ready, a changed STATUS
bootId closes the session and requires a new handshake. Valid LIVE_SAMPLE follows
the preview rules below; other unsolicited LIVE/batch messages have no import
side effects. Protocol/framing errors
terminate the session; there are no automatic retries or reconnects.

Timeouts: scanner barrier 15 s, initialize/connect 10 s each, Info/subscribe/write
5 s each, STATUS response 5 s after write completion, cleanup caller wait 10 s.
Binding load/save caller waits are 5 s; pending operations remain tracked until
settled before the session slot can be reused.
The existing fragment deadline is 5 s. Connect accepts an AbortSignal for the
handshake; disconnect is explicit after readiness. Backgrounding/destruction
cancels the session and removes local timers/listeners. Native calls cannot be
forcibly cancelled: the session slot stays reserved while late calls settle,
then subscription cleanup/disconnect run. A stuck native call or failed cleanup
quarantines the slot rather than risking an old disconnect affecting a new
connection. Caller waits remain bounded; recovery from a stuck adapter currently
requires recreating the application. Repeated cleanup never repeats native work.

## Explicit journal catch-up

`../data-access/ble-journal-sync.ts` connects an exclusive journal lease to
BatchReceiver and IndexedDB. DeviceDiscovery uses the route's coordinator and
BLE_SESSION, together with the same Co2Storage and Co2History. No extra
storage/history/source/simulator instance is created.
After handshake the UI offers an explicit download button, progress and cancel.
Device switching, disconnect and repeat download are blocked during the run.
Collapsing the block retains the same services/run and never starts a download.
Backgrounding still disconnects and stops the run. Browser UI remains unavailable
for native BLE. There is no automatic download or automatic TIME_SET.

savedMeasurements resets on each explicit run and counts READY entries only after
durable commit, including identical already-present measurements. GAP/UNDATABLE
are not included. This is not an ACK_ACCEPTED counter: it remains nonzero if ACK
is lost after commit. The UI states that already-present records are included,
shows the explicit result, and leaves the Sensor preview independent of the download.

`run(signal?)` allows one run and requires capabilities `0x000A`. It reads a fresh
STATUS, returns `time-required` if time is invalid or UNDATED exists, and never
sends TIME_SET: there is no agreed uncertaintyMs estimator. With ready time it
freezes STATUS.latest, reads the durable bigint cursor, and issues sequential
FETCH(cursor, 100) through `lease.fetch()`. JournalLease validates the requestId,
afterSequence, batch identity and count, and returns a complete copied packet and
its token. Entries are bounded to 100, and the receive queue to 102 messages
(BEGIN + entries + END). It keeps the 30-second deadline from the original BEGIN
active through BatchReceiver's digest verification, until commit starts.
The final packet is imported whole, even if it advances past the fixed target.
Newly produced records do not extend this run's target.

READY, GAP, UNDATABLE, receipt and cursor commit atomically. BatchReceiver exposes
`completion`, resolving only after `transport.commitAndSend`; interruption, digest,
storage and 30-second reception/verification timeout errors reject it. The receiver
supplies an atomic commit callback to `lease.commitAndAcknowledge(token, ack, commit)`.
The lease checks the one-use token and exact ACK fields, awaits commit (Co2Storage
resolves on transaction.oncomplete), then registers/writes ACK and waits for matching
ACK_ACCEPTED requestId and batchId AND completion of the Control write. There is
no public raw request/ACK method. A next FETCH is rejected while a packet is
receiving, verifying, committing or awaiting confirmation; the coordinator also
rereads a cursor equal to the packet boundary and greater than its input.

TIME_PENDING, BUSY and CLOCK_INVALID produce explicit results, with no polling or
automatic retries. Missing/wrong ACK_ACCEPTED or any invalid packet stops the run
and closes the link. A committed cursor survives ACK loss and is used on the next
explicit connection/run. Cancellation, history clear, disconnect and background
stop the entire run; receiver cancellation also aborts an uncommitted import.
Errors and cancellation of active work close the link. CANCEL_BATCH is not
implemented, so revocation never guesses that an outstanding snapshot is safe to
reuse. Idle release, normal completion and time-required results retain the
connection. GAP_NOTICE/LIVE_READY do not
import or advance cursors. An already-committed packet cannot be rolled back by
a later cancellation; manual clear still removes it.

Co2History.imported() refreshes counts/chart after commit, preserves past table
snapshots, and auto-refreshes only the live first page. Hidden history does not
query chart/table. Pending-table indicators check new primary keys in the selected
time range with a streaming IndexedDB cursor, never all records in memory.
Journal catch-up does not modify the current CO2 preview. Preview can
continue between complete journal messages on the same Events assembler; it never
enters journal listeners, batch queues or imports. No automatic time synchronization
is implemented. Native GATT/CCCD,
radio loss and Android lifecycle timing still require hardware verification.

- `codec.ts`: Info, message bodies, canonical entries and bounded batch digest
  input (including contiguous sequence coverage and duplicate-ID checks).
- `fragments.ts`: framing/CRC and one `FragmentAssembler` per connection direction.
  `push()` returns `null` until a complete, validated message is available;
  malformed input throws `ProtocolError` and drops the incomplete message.
- `binary.ts`: strict integer/UUID fields and CRC-32/ISO-HDLC primitives.

All 64-bit fields are `bigint`. Call `dispose()` on disconnect. Call `reset()`
only when starting a new connection: it also clears the bounded message-ID bitmap.
Message IDs are unique within one BLE connection AND one direction, not monotonic.
Phone Control IDs (0..65534) and ESP32 Events IDs (0..65535) are independent: the
same numeric ID in opposite directions never conflicts. requestId references the
Control ID; it does not consume an Events ID. Each started assembly consumes its
ID even after CRC/field/order errors or timeout. Retry the logical operation using
a fresh messageId (and new CRC), keeping measurementId and READY data unchanged;
ACK retries keep their batchId/count/digest. Never retransmit individual fragments.
On exhaustion of either namespace, disconnect and start a new connection before
resetting; wrapping/reusing IDs or resetting on the existing connection is forbidden.
The pure fragmentMessage() encoder is stateless: the future sender must allocate
IDs; one FragmentAssembler per direction enforces receiver-side uniqueness. A five-second timer releases the partial
buffer even without further input; an injected monotonic clock additionally checks
the deadline when input arrives. The assembler retains at most 128 payload bytes
and an 8192-byte ID bitmap, with one timer, and never emits partial fields.

`batch-receiver.ts` accepts decoded BATCH_BEGIN/ENTRY/END through `receive()`.
It holds at most 100 entries and enforces a 30-second reception/verification
deadline from BEGIN (also released by a timer without further input). It checks
identity, order, coverage, count and SHA-256 before calling atomic storage import.
It does not implement Bluetooth, UI, FETCH scheduling, sender messageId allocation
or waiting for ACK_ACCEPTED. Route LIVE and other messages separately. Fragment
errors and disconnect must call `disconnect()`; call `dispose()` when finished.
Receiving a valid `BATCH_ENTRY` alone never confirms or imports a complete batch.

Storage schema v5 adds `bleUndatable`, `bleGaps` and `bleReceipts`, preserving v4
measurements, keys, indexes and device cursors. READY, terminal UNDATABLE, GAP,
receipt and cursor commit in one transaction. UNDATABLE has no fabricated UTC,
GAP never deletes existing measurements, and only READY enters HTTP sync counts.
Repeated records preserve synced. Full clear removes all BLE history/cursors/receipts
atomically while keeping simulator identity. Storage notifies registered receivers
and aborts active imports before clearing; batches still collecting or hashing are
also invalidated. New BEGIN/import is rejected while clear is in progress. This
coordination covers storage instances sharing one IDBFactory in one JavaScript
context; it does not implement cross-tab messaging or real Bluetooth integration.

Service records (GAP, UNDATABLE and receipt) receive a local `receivedAt` on first
successful import, independently of sensor UTC. Repeats preserve it. `prune()` is
already called on app startup and hourly; it now scans service stores in primary-key
pages of at most 200 records, without loading all values or holding one long write
transaction. Service expiry uses the two-calendar-year anniversary of receivedAt
in local time, clamping February 29 to February 28; the exact boundary is retained.
Measurement retention continues to use the measurement time index. Service pruning
does not delete device cursors or simulator identity. No new schema version is
needed for these value fields, so existing draft v5 databases remain readable.

Old draft v5 service records without receivedAt have no recoverable reception time.
The first prune assigns local observation time once and `receivedAtEstimated: true`;
this starts their retention grace period and never creates a measurement timestamp.
UNDATABLE still has no UTC. On a stale replay with an expired receipt, existing
READY records are compared by identity/content, synced is preserved, and the cursor
does not decrease. The expired receipt is not recreated, even for a fresh batchId.
If service entries themselves have expired, a stale mixed packet is rejected rather
than silently accepted or resurrected: their original content can no longer be proven.

Schema v6 adds native indexes over existing values: `measurements.deviceSequence`
on `[deviceId, source, sequence]` and `bleGaps.deviceId`. No measurement fields,
keys, IDs, cursors or service reception times are rewritten. Chart history checks
GAP between adjacent same-device/same-segment sensor readings before envelope
aggregation. A GAP breaks the chart only if at least one sequence in its intersecting
range is absent from local READY measurements. Coverage can include records outside
the displayed time filter, but those records are not plotted. Sequence uses bigint
throughout; decimal-string index seeks are split at digit boundaries and streamed
in short pages. GAP and UNDATABLE never receive fabricated chart timestamps.
Continuity labels are chart projections only; persisted device segment IDs stay intact.

The injected transport's `commitAndSend(ACK, commit, signal)` awaits the supplied
atomic commit before sending ACK; it must honor revocation and await confirmation.
Disconnect during digest or the IndexedDB transaction cancels import and suppresses
ACK; cancellation must also be honored by the future transport while sending.
Disconnect/error after durable commit cannot roll it back: data and cursor remain,
and the sender may safely repeat the packet after a lost ACK. Repeated batchId
must match the stored receipt; a fresh batchId with identical entries is also safe.
The 30-second deadline stops after successful reception/digest validation; database
commit has no arbitrary timeout, but remains cancellable until commit completes.

Info v1.0 accepts capability subsets of 0x000F; v1.1 accepts subsets of 0x001F,
including zero in both versions. Unknown versions/bits are rejected.
`encodeInfo(deviceId, capabilities, minor)` retains minor=0 by default.
Required operation capabilities are checked above the wire codec.
`supportsLiveSample(info)` checks valid Info v1.1 plus bit 0x0010 for
preview consumers; LIVE_READY's bit 0 does not grant LIVE_SAMPLE.
UUIDs, including batchId, are v4 with the RFC variant.
READY, TIME_SET and TIME_ACCEPTED share the inclusive UTC range
0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z, or bigint Unix milliseconds
-62135596800000n .. 253402300799999n. Zero and pre-1970 times are valid encodings.
Clock quality and the backend's five-minute future-time rule are separate semantic
checks; no clock-accuracy threshold is invented here.

Tests contain literal wire/CRC vectors and two SHA-256 vectors computed independently
with Node `crypto.createHash`, as well as the standard CRC check for `123456789`.

## LIVE_SAMPLE v1.1 preview

Type 0x8A: bootId:uuid, sampleCounter:u64, uptimeMs:u64, ppm:u32.
The body is exactly 36 bytes; with CRC it is 40 bytes in three 20/20/18-byte
ATT values. The frame version is still major=1, not minor=1. sampleCounter is
1..2^64-1 per boot and is not a durable journal sequence. uptimeMs allows zero.
Both u64 fields use bigint; ppm remains 1..100000. Preview has no UTC,
measurementId, persistence, import, ACK or cursor semantics.
Shared Info/body/CRC/frame fixtures live in `docs/test-vectors/ble-live-sample-v1.1.json`
and are consumed by both C++ and `live-sample.spec.ts`.

Both the Java core and the legacy BleConnection test implementation accept preview only after the matching STATUS handshake and all
Control writes complete, with Info minor=1 and capability 0x0010. bootId must match
the handshake STATUS. sampleCounter must strictly increase and uptimeMs must not
decrease within the connection; comparisons use bigint. Equal uptime is valid,
counter gaps are valid. Wrong bootId, duplicate/regressing counters, regressing
uptime, premature or unsupported preview are ignored without refreshing freshness.
Framing/CRC/field errors still close the session. Each reconnect starts new order
checks; callbacks retain the owning session identity and obsolete callbacks are
ignored.

The non-replaying `previewEvents` stream emits ready/unavailable transitions and
validated samples. `Co2Monitor` uses it solely for the current Sensor display,
which starts empty and waits for a new sample (— until then). When an Android
service session already exists, attach/resume may restore its last sample with
the original elapsedRealtime receipt timestamp; only its remaining 15-second
lifetime is used. Duplicate snapshots never rearm the timer. It maintains
one sample and one 15-second timeout, also while waiting for the first sample
after readiness. Disconnect/unsupported preview is unavailable immediately;
15 seconds without an accepted new sample clears the value and shows unavailable.
A fresh sample restores the preview. There is no simulator fallback or source
selection in the normal UI. Scope destruction removes the subscriber and timer.

The normal route binds `CO2_SOURCE` to an inactive source for Co2History, with no
simulator instance or generated measurements. Co2Simulator and source overrides
remain available to tests. Sensor preview has no
Co2Reading wall-clock time, readings/persistence observable, measurementId or
storage dependency. It never calls IndexedDB, history import, cursor APIs or HTTP.
The manual journal path may still persist canonical READY entries independently
of preview. Existing history and manual synchronization are preserved, including
earlier simulator records; explicitly supplied test sources still persist normally.

Isopropanol contacted the membrane of **our prototype's** SCD41. Its accuracy is
unconfirmed even when data and CRC are valid. This remains a documented limitation
of that sensor, without a warning on the main screen; it is not a field,
capability or validity rule in the BLE protocol.

Tests cover handshake/version/capability gates, bigint ordering, bootId, CRC,
old callbacks, Sensor-only startup, first/subsequent sample timeouts, reconnect,
shared route DI and cleanup. Integration tests use the real codec/session/UI and
fake IndexedDB/native GATT/HTTP boundaries: preview changes the display without
database/history/backend records, simulator records still persist/upload, and
manual journal catch-up works with preview interspersed between journal messages.
