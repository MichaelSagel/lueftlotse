# BLE v1 codec

Pure TypeScript implementation of `docs/ble-protocol-v1.md`. No Angular,
Bluetooth, IndexedDB or application state dependencies. SHA-256 uses Web Crypto.

## Native connection boundary

`../data-access/ble-connection.ts` now implements a separate Angular handshake
service using the replaceable `BLE_ADAPTER` token. It awaits `BleScanner.stop()`,
initializes BLE, connects, reads/validates Info v1.0, subscribes to Events, then
sends GET_STATUS and waits for the matching STATUS requestId. DeviceDiscovery provides one
BleConnection together with the same BleScanner in its component scope. Its UI
shows handshake progress and Info deviceId, explicitly disconnects before switching
devices, and preserves a ready connection when collapsed. Scanning is disabled
during connection work and while connected; disconnect first to scan again.

Only Android is supported by the default adapter; browser connect rejects before
scanner/native calls. All known capability subsets are valid for this handshake;
there is no invented live/journal capability requirement for GET_STATUS.

One session owns one Events assembler, a Control ID allocator (0..65534), and a
serialized queue of at most four STATUS commands including the active command.
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

BatchReceiver, FETCH/TIME_SET/ACK handling, sensor Co2Source and measurement imports
are **not connected** to this service. The connection UI confirms STATUS only, not
reception of sensor measurements. Existing simulator DI and local history are
unchanged. Tests use a fake adapter and fake timers; native
GATT/CCCD behavior, radio loss and Android lifecycle timing still require hardware.

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

Info v1.0 capabilities is a bitmask: any subset of known bits 0x000F (including
zero) is accepted; unknown bits are rejected. Required operation capabilities are
checked above this codec. UUIDs, including batchId, are v4 with the RFC variant.
READY, TIME_SET and TIME_ACCEPTED share the inclusive UTC range
0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z, or bigint Unix milliseconds
-62135596800000n .. 253402300799999n. Zero and pre-1970 times are valid encodings.
Clock quality and the backend's five-minute future-time rule are separate semantic
checks; no clock-accuracy threshold is invented here.

Tests contain literal wire/CRC vectors and two SHA-256 vectors computed independently
with Node `crypto.createHash`, as well as the standard CRC check for `123456789`.
