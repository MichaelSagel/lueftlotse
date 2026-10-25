# BLE v1 codec

Pure TypeScript implementation of `docs/ble-protocol-v1.md`. No Angular,
Bluetooth, IndexedDB or application state dependencies. SHA-256 uses Web Crypto.

## Native connection boundary

`../data-access/ble-connection.ts` now implements a separate Angular handshake
service using the replaceable `BLE_ADAPTER` token. It awaits `BleScanner.stop()`,
initializes BLE, connects, reads/validates Info v1.0/v1.1, subscribes to Events, then
sends GET_STATUS and waits for the matching STATUS requestId. DeviceDiscovery provides one
BleConnection together with the same BleScanner in its component scope. Its UI
shows handshake progress and Info deviceId, explicitly disconnects before switching
devices, and preserves a ready connection when collapsed. Scanning is disabled
during connection work and while connected; disconnect first to scan again.

Only Android is supported by the default adapter; browser connect rejects before
scanner/native calls. All known capability subsets are valid for this handshake;
there is no invented live/journal capability requirement for GET_STATUS.

One session owns one Events assembler and a Control ID allocator (0..65534).
STATUS requests remain serialized and bounded to four including the active one.
Journal ownership is exclusive; journal requests use a separate serialized Control
write queue and at most four active exchanges. Waiting for FETCH never occupies
the write queue or prevents ACK. Expected responses are registered before writes.
Events IDs are independent. Request matching is installed before writing, and a
write response alone never establishes readiness. Unsolicited STATUS may update
status, but cannot complete a GET_STATUS request. Unexpected valid LIVE/batch
messages have no import/current-reading side effects. Protocol/framing errors
terminate the session; there are no automatic retries or reconnects.

Timeouts: scanner barrier 15 s, initialize/connect 10 s each, Info/subscribe/write
5 s each, STATUS response 5 s after write completion, cleanup caller wait 10 s.
The existing fragment deadline is 5 s. Connect accepts an AbortSignal for the
handshake; disconnect is explicit after readiness. Backgrounding/destruction
cancels the session and removes local timers/listeners. Native calls cannot be
forcibly cancelled: the session slot stays reserved while late calls settle,
then subscription cleanup/disconnect run. A stuck native call or failed cleanup
quarantines the slot rather than risking an old disconnect affecting a new
connection. Caller waits remain bounded; recovery from a stuck adapter currently
requires recreating the application. Repeated cleanup never repeats native work.

## Explicit journal catch-up

`../data-access/ble-journal-sync.ts` connects an exclusive journal session to
BatchReceiver and IndexedDB. DeviceDiscovery provides one coordinator alongside
its existing BleConnection; Co2Storage and Co2History are inherited from the
application route. No new storage/history/source/simulator instance is created.
After handshake the UI offers an explicit download button, progress and cancel.
Device switching, disconnect and repeat download are blocked during the run.
Collapsing the block retains the same services/run and never starts a download.
Backgrounding still disconnects and stops the run. Browser UI remains unavailable
for native BLE. There is no automatic download or automatic TIME_SET.

savedMeasurements resets on each explicit run and counts READY entries only after
durable commit, including identical already-present measurements. GAP/UNDATABLE
are not included. This is not an ACK_ACCEPTED counter: it remains nonzero if ACK
is lost after commit. The UI states that already-present records are included,
shows the explicit result, and keeps the main CO2 reading labeled Simulator.

`run(signal?)` allows one run and requires capabilities `0x000A`. It reads a fresh
STATUS, returns `time-required` if time is invalid or UNDATED exists, and never
sends TIME_SET: there is no agreed uncertaintyMs estimator. With ready time it
freezes STATUS.latest, reads the durable bigint cursor, and issues sequential
FETCH(cursor, 100). BEGIN must match requestId, afterSequence and limit; entries
are bounded to 100, and the receive queue to 102 messages (BEGIN + entries + END).
The final packet is imported whole, even if it advances past the fixed target.
Newly produced records do not extend this run's target.

READY, GAP, UNDATABLE, receipt and cursor commit atomically. BatchReceiver exposes
`completion`, resolving only after commit and transport.send; interruption, digest,
storage and 30-second reception/verification timeout errors reject it. Here
transport.send registers the ACK response before writing, then waits for matching
ACK_ACCEPTED requestId and batchId. The next FETCH requires that confirmation and
a reread cursor equal to the packet throughSequence and greater than its input.

TIME_PENDING, BUSY and CLOCK_INVALID produce explicit results, with no polling or
automatic retries. Missing/wrong ACK_ACCEPTED or any invalid packet stops the run
and closes the link. A committed cursor survives ACK loss and is used on the next
explicit connection/run. Cancellation, history clear, disconnect and background
stop the entire run; receiver cancellation also aborts an uncommitted import.
Errors/cancellation close the link; normal completion and time-required results
release journal ownership without disconnecting. GAP_NOTICE/LIVE_READY do not
import or advance cursors. An already-committed packet cannot be rolled back by
a later cancellation; manual clear still removes it.

Co2History.imported() refreshes counts/chart after commit, preserves past table
snapshots, and auto-refreshes only the live first page. Hidden history does not
query chart/table. Pending-table indicators check new primary keys in the selected
time range with a streaming IndexedDB cursor, never all records in memory.
Co2Source/current CO2 and the simulator are not modified. The connection UI still
confirms STATUS only, not live sensor measurements. No live sensor source,
automatic time synchronization or firmware is implemented. Native GATT/CCCD,
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

The injected transport's `send(ACK, signal)` is called only after commit.
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
`supportsLiveSample(info)` checks valid Info v1.1 plus bit 0x0010 for future
preview consumers; LIVE_READY's bit 0 does not grant LIVE_SAMPLE.
UUIDs, including batchId, are v4 with the RFC variant.
READY, TIME_SET and TIME_ACCEPTED share the inclusive UTC range
0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z, or bigint Unix milliseconds
-62135596800000n .. 253402300799999n. Zero and pre-1970 times are valid encodings.
Clock quality and the backend's five-minute future-time rule are separate semantic
checks; no clock-accuracy threshold is invented here.

Tests contain literal wire/CRC vectors and two SHA-256 vectors computed independently
with Node `crypto.createHash`, as well as the standard CRC check for `123456789`.

## LIVE_SAMPLE codec-only extension

Type 0x8A: bootId:uuid, sampleCounter:u64, uptimeMs:u64, ppm:u32.
The body is exactly 36 bytes; with CRC it is 40 bytes in three 20/20/18-byte
ATT values. The frame version is still major=1, not minor=1. sampleCounter is
1..2^64-1 per boot and is not a durable journal sequence. uptimeMs allows zero.
Both u64 fields use bigint; ppm remains 1..100000. Preview has no UTC,
measurementId, persistence, import, ACK or cursor semantics.
Shared Info/body/CRC/frame fixtures live in `docs/test-vectors/ble-live-sample-v1.1.json`
and are consumed by both C++ and `live-sample.spec.ts`.

Version/capability audit: encodeInfo/decodeInfo use version-specific masks;
fragment headers continue checking major=1; journal capability 0x000A is unchanged.
The handshake test's unsupported minor is now 2, with explicit tests for both
supported minors. The existing UI error wording mentioning v1.0 is presentation,
not a version check, and is unchanged in this codec-only step. BLE publication,
UI source selection, message consumers and storage are not added by this extension.
