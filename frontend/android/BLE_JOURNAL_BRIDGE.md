# Explicit WebView journal bridge

The Android route selects `NativeBleSession` for the page, discovery and manual
journal download through the single `BleService` GATT owner. The adapter runs
one-time binding migration before explicit connection. It never starts a download
or connection automatically. Browser sessions make no native calls.

## Ownership and bounded delivery

`ServiceJournal` is a volatile coordinator on the service command queue. It uses
the same `GattTransport` and private `ProtocolSession` as handshake and preview.
Transport calls still execute on the GATT serial loop. Their returned command IDs
are separate from response completion; an early response is held in one bounded
slot until its command ID is known. Core validation still waits for every Control
write response as well as the correlated Events response.

There is one exclusive journal lease per connection. Its native token contains
`runId`, protocol `generation`, a fresh `clientId`, and the core `leaseId`. The
Capacitor plugin instance/lifecycle also owns the lease; another WebView cannot
use its tokens. Each FETCH adds a fresh `operationId` and each batch a `ticketId`.
Previous connection, client, lease, operation and batch callbacks cannot authorize
new work. At most one journal operation is pending; FETCH accepts 1–100 entries.

Only a completely validated core batch is exposed. The non-retained Capacitor
`journalEvent` stream delivers `BEGIN`, up to 100 `ENTRY` events, then `END`.
Each carries `token`, `operationId`, `ticketId` and a protocol `message` object.
BEGIN/ENTRY/END correspond to BATCH_BEGIN/BATCH_ENTRY/BATCH_END. A revoked lease
emits `REVOKED` when the WebView can still receive it. No event backlog is replayed
to a replacement WebView. The core and TypeScript each buffer at most one batch.

All protocol uint64 values, including cursor boundaries, sequence and uptime,
cross JSON as canonical decimal **strings**. UTC is also a signed decimal string;
digest is 64 lowercase hexadecimal characters. The TypeScript boundary decodes
to BigInt and then validates with the existing codec. JSON numbers are rejected
for uint64; the range includes `18446744073709551615` without rounding.

## Bridge calls and the commit boundary

| Call | Result / authorization |
| --- | --- |
| `journalAcquire({runId})` | Requires the ready service and visible Activity; returns `{token}`. Rejects a second lease. |
| `journalStatus({token})` | Awaits the correlated STATUS response. |
| `journalFetch({token, operationId, afterSequence, limit})` | Awaits a verified batch and emits its events, or returns STATUS/TIME_PENDING/protocol error. |
| `journalBeginCommit({token, ticketId, ack})` | Checks batchId, throughSequence, count and digest; returns a fresh one-use `commitToken`. Sends no ACK. |
| `journalCommitted({token, ticketId, ack, commitToken, committed:true})` | Rechecks all metadata and generations, consumes the commit token, and queues ACK. Resolves only after the corresponding ACK_ACCEPTED. |
| `journalHeartbeat({token})` | Extends the visible client's lease, without reading or persisting journal data. |
| `journalRevoke({token})` | Revokes the captured lease; stale tokens have no effect on a later lease. |

`NativeJournalLease.commitAndAcknowledge` obtains the native commit token, awaits
the callback supplied by the **unchanged** `BatchReceiver`, rechecks cancellation,
and only then calls `journalCommitted`. `BatchReceiver` still verifies the digest
and calls `Co2Storage.importBleBatch`; measurement rows, receipt and cursor commit
atomically in IndexedDB. Native code trusts this explicit completion assertion;
it cannot inspect an IndexedDB transaction. Neither receipt of END nor a Control
write completion is a commit acknowledgement.

The next FETCH is blocked until the core receives the ACK_ACCEPTED with the exact
ACK requestId and batchId and all ACK fragment writes have completed. There is no
automatic ACK retry. If ACK or ACK_ACCEPTED is lost, the core times out and closes
the connection. The committed IndexedDB transaction remains; a later **manual**
download reads its local cursor. The service persists no cursor, receipt, journal
measurement or LIVE_SAMPLE, and cannot perform catch-up without the WebView.

## Revocation and lifecycle

Activity pause or plugin destruction revokes the plugin owner's lease. The
TypeScript adapter also revokes on visibility loss, client destruction, AbortSignal
and connection replacement. A two-second heartbeat with a six-second native
deadline covers WebView reload/crash and missing lifecycle callbacks. Native
deadlines use `elapsedRealtime`; repeated state reads never refresh sample age.

An idle lease can be released while live BLE preview continues in the service.
Acquisition in flight, receiving a packet, preparing/performing commit, and ACK
in flight are treated conservatively: revocation closes that connection. No
unconfirmed ACK is generated. A late acquisition, transaction completion or
callback cannot revive the lease. The core's existing five-second response/write
and thirty-second batch deadlines remain in force, including while a WebView
transaction is slow. Local commit can therefore finish after disconnection;
that is durable local data, with no permission to send a stale ACK.

`NativeBleSession` implements the existing session interface for the page,
discovery and `BleJournalSync`, with local client revocation and a single lease.
Its construction does no bridge IO. It only polls service state while attached
clients exist; it never creates GATT. Snapshot previews are volatile, are not
saved to history. On attach/resume they retain the original native receipt time
and only the remaining freshness window; expired data stays unavailable. `closeSession`
cancels a captured run without changing connection intent; explicit `disconnect`
continues to persist disabled intent before close.

## Checks and device verification

JVM tests drive the real core through a fake transport: single ownership, early
responses, BEGIN/ENTRY/END, full uint64, commit gating, wrong metadata, one-use
tokens, client expiry, stale generations and lost ACK_ACCEPTED. Frontend tests use
the real BatchReceiver and fake-indexeddb transactions, and also run the existing
BleJournalSync over the selected adapter. They cover shared platform DI, migration
failure/retry, scan-stop ordering, revocation during commit, late acquisition/events,
heartbeat loss, original preview age on resume and preview non-persistence.

Run the full frontend tests and production build, then the JVM/Android compile
command in [BLE_SERVICE.md](BLE_SERVICE.md#verification-and-limits). These commands
do not package an APK. Actual WebView destruction, screen lock, radio loss and
on-device transfer still require a later authorized device test. Automatic
connection, reconnect and CO₂ notifications are not implemented.
