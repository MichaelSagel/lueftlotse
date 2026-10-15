# BLE v1 codec

Pure TypeScript implementation of `docs/ble-protocol-v1.md`. No Angular,
Bluetooth, IndexedDB or application state dependencies. SHA-256 uses Web Crypto.

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
