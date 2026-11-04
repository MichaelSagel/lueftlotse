# Lüftlotse BLE protocol v1

Status: specification for the first prototype, partially implemented. The ESP32-C3 + SCD41 is the peripheral; the Android/iOS application is the central. The normative terms “must” and “must not” define compatibility requirements. Security and journal capacity have not yet been defined; this is not a specification for a finished public device.

v1.1 adds the LIVE_SAMPLE preview. The current firmware implementation advertises Info v1.1 with capabilities=0x0010 and transmits new SCD41 readings after subscription and the STATUS handshake. The journal, LIVE_READY, TIME_SET and FETCH are not yet implemented in firmware. The current UI uses Sensor readings rather than Simulator as its main view. The browser displays received LIVE_SAMPLE values, saves them locally and automatically sends them to the HTTP batch API. This browser-only client behavior is described in section 11; it does not change the normative LIVE_SAMPLE contract in section 5.1 or Android persistence.

## 1. Identity and persistent journal

- `deviceId`: a random UUID v4 stored once in NVS. It is not a BLE address, a name or the SCD41 serial number. A normal reboot/update preserves it. A full factory reset creates a new deviceId and a new journal.
- `measurementId`: a random UUID v4 generated on the ESP32 and stored once together with the record. Reading the record again, changing phones and rebooting do not change it.
- `bootId`: a UUID v4 for each boot; stored in every record.
- `segmentId`: a UUID v4 identifying an uninterrupted measurement session. It changes on boot, when measurements stop/resume, on sensor failure, measurement loss or a step change in the clock. A BLE disconnect alone does not change the segment.
- `sequence`: uint64, starting at 1 and strictly increasing within a deviceId. Numbers are assigned only to measurements that are stored. They are not reused after a restart or eviction. Counter exhaustion is an error, not wraparound.

The journal is a persistent ring buffer of fixed capacity, which has not yet been chosen. The record, its ID and advancement of journal state must be crash-consistent. Commit to flash first, then send the notification. The implementation must recover the sequence high-watermark after a power failure; a simple RAM counter is unacceptable. Unused numbers reserved in advance must not be represented as lost measurements: v1 does not use this reservation method.

New measurements evict the oldest records and continue to be stored without a phone and without ACK. Acknowledgements do not change eviction order. A flash failure that prevents a commit returns STORAGE_ERROR: unstored data must not be presented as stored. An invalid SCD41 reading is not replaced with the previous ppm value and does not create a fictitious record.

## 2. Time and record states

| Code | State | Meaning |
| --- | --- | --- |
| 0 | UNDATED | Current boot; UTC may still be recovered |
| 1 | READY | Final UTC; the record is ready for import |
| 2 | UNDATABLE | Permanently undatable record from a previous boot |

Monotonic `uptimeMs` is uint64 milliseconds since the start of bootId. UTC is int64 milliseconds since the Unix epoch; no time zone is transmitted over BLE.

The phone sends TIME_SET with the current UTC. When the complete message is accepted, the ESP32 captures the `(utcMs, uptimeMs)` pair and its uncertainty. For the first prototype, this is an estimate based on the phone clock, not guaranteed accurate world time. The phone accounts for transmission time; accuracy and the acceptable threshold remain open questions.

On the first time anchoring, UNDATED records from the same boot receive `utcMs = anchorUtcMs + record.uptimeMs - anchorUptimeMs`. Each record is atomically transitioned to READY in the persistent journal BEFORE it is first returned as READY. When the clock is known, new measurements are committed directly as READY.

**The point of finalization is the durable transition to READY on the ESP32.** After that, all canonical fields under a measurementId are immutable, including UTC and segmentId, even before import by the phone. A new clock correction affects only future records and starts a new segmentId. A repeated TIME_SET during the same boot must first finish processing UNDATED records using the first accepted anchor; re-anchoring records that are already READY is prohibited.

On a new boot, all surviving UNDATED records with another bootId are treated as UNDATABLE. This can be derived from bootId without rewriting all records in flash. Their IDs, ppm, segmentId and uptime are preserved; UTC is never fabricated for them. UNDATABLE is a terminal state; later time from the phone cannot correct it. FETCH is not served during journal recovery (BUSY).

UNDATED records are not imported as ordinary measurements. The phone stores UNDATABLE records in a separate journal of undatable records; they are not sent to the current batch API or included in the calendar-based chart. Their count/presence must be visible to the user. v1 does not export individual UNDATED records: they are indicated by TIME_PENDING.

## 3. GATT and version

Custom UUIDs, exact values:

| Object | UUID | Properties |
| --- | --- | --- |
| Lüftlotse service | 9c6b1000-7a3e-4d9f-8b52-6e210f42a001 | service |
| Info | 9c6b1001-7a3e-4d9f-8b52-6e210f42a001 | Read |
| Control | 9c6b1002-7a3e-4d9f-8b52-6e210f42a001 | Write with response |
| Events | 9c6b1003-7a3e-4d9f-8b52-6e210f42a001 | Notify, CCCD |

Info is exactly 20 bytes without fragmentation: `major:u8=1, minor:u8, deviceId:uuid16, capabilities:u16`. capabilities is a bitmask:

| Version | minor | Known mask | Capabilities |
| --- | --- | --- | --- |
| v1.0 | 0 | 0x000F | Bit 0 LIVE_READY, 1 journal, 2 time synchronization, 3 non-destructive batch ACK |
| v1.1 | 1 | 0x001F | The same bits 0..3; bit 4 (`0x0010`) LIVE_SAMPLE preview |

Any subset of the mask for the corresponding version is accepted, including 0x0000. Bit 0 does not mean LIVE_SAMPLE; bit 4 does not imply LIVE_READY or a journal. v1.0 with bit 0x0010 is invalid. Unknown bits are prohibited; otherwise, INVALID_MESSAGE. Operation-specific capability requirements are checked by the layer above the codec. LIVE_SAMPLE requires both Info v1.1 and capability 0x0010.

An unknown major or minor (including 1.2) prohibits commands and import. v1.1 codecs also accept v1.0; an older client that understands only v1.0 rejects Info v1.1. Automatic version downgrade is not defined. The v1.0 formats, GATT UUIDs and major=1 in fragment headers are unchanged.

When the corresponding capability is available, after CCCD subscription the device emits READY records through LIVE_READY and emits STATUS on state changes. This does not confirm delivery. FETCH is always used to recover missed notifications. Only one central is allowed at a time. Stopping reception on the phone does not stop autonomous measurements on the ESP32. LIVE_SAMPLE is a separate preview without recovery through FETCH (section 5.1). It does not require journal, TIME_SET or ACK_BATCH.

## 4. Encoding and fragmentation

All numbers are little-endian, without alignment or padding. UUIDs are 16 bytes in the order of hexadecimal pairs in the canonical string, without mixed Microsoft GUID byte order. JavaScript handles uint64 as BigInt/string, not as an unsafe Number.

All data UUIDs (deviceId, measurementId, bootId, segmentId, batchId) are UUID v4 with the RFC variant (the most significant bits of byte 8 are 10). The ESP32 creates batchId for a new snapshot; an ACK retry preserves the original batchId. This data-version validation rule does not apply to GATT UUIDs.

READY.utcMs, TIME_SET.utcMs and TIME_ACCEPTED.utcMs share the inclusive range 0001-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z: int64 Unix milliseconds from -62135596800000 to 253402300799999. Zero and negative values within the range are valid. Out-of-range values are rejected. Clock quality and the server's future-time limit are separate rules. All ppm values are integers in 1..100000; firmware additionally validates SCD41 readings.

Control and Events transmit ATT values of 7..20 bytes:

| Offset | Field |
| --- | --- |
| 0 | major:u8 = 1 |
| 1 | type:u8 |
| 2..3 | messageId:u16 |
| 4 | fragmentIndex:u8, starting at 0 |
| 5 | fragmentCount:u8, 1..10 |
| 6..19 | fragment payload, 1..14 bytes |

A logical message is `body || crc32:u32`; its length is 4..128 bytes. CRC-32/ISO-HDLC: polynomial 0x04C11DB7 (reflected 0xEDB88320), init/xorout 0xFFFFFFFF, refin/refout true. CRC is computed over `major:u8 || type:u8 || messageId:u16-LE || body` and appended little-endian. This detects corruption; it is not authentication.

Every fragment except the last carries exactly 14 bytes; the last carries 1..14. fragmentCount = ceil(logicalLength / 14). Even an empty body carries 4 CRC bytes. A GATT write must not exceed 20 bytes: an increased MTU is optional.

The uniqueness scope of messageId is one BLE connection AND one direction. Phone Control uses 0..65534 (65535 is reserved); ESP32 Events uses 0..65535. The namespaces are independent: Control messageId=7 and Events messageId=7 may exist simultaneously. A response's requestId refers to the Control ID and does not reserve an Events number. Increasing IDs are not required; uniqueness is mandatory. All fragments of one message use the same ID.

Starting assembly consumes the ID even after a CRC, field, ordering or timeout error. The sender considers an ID consumed from the first transmission attempt. After an error or an uncertain outcome, the ENTIRE logical message is retried with a NEW messageId and a recomputed CRC. Retrying individual fragments is prohibited. Retrying an operation preserves measurementId and READY data; an ACK retry also preserves batchId/throughSequence/count/digest. The requestId of a new response refers to the new Control messageId. If the header is unusable, the receiver may not know the ID, but the sender is still not allowed to reuse the transmitted number.

If either direction's ID space is exhausted, a disconnect and a new BLE connection are required. Wraparound, ID reuse and resetting uniqueness tracking on the same connection are prohibited. A new connection resets both ID spaces, but not measurementId or the durable cursor. The receiver maintains a separate bounded bitmap for each direction. A stateless encoder does not allocate IDs: this is the responsibility of the future transport layer.

Fragments of one message are sent strictly in order and consecutively: interleaving fragments of different messages is prohibited. Interleaving LIVE/batch traffic between complete messages is permitted. An invalid index, duplicate, size, count, CRC or version resets the entire assembly; partial RECORDs are never stored. Size is checked BEFORE memory allocation.

The assembly timeout is 5 seconds from the first fragment and is not extended. Control is transmitted one write-with-response at a time; the ATT write response means only that the fragment was accepted. The command result is a separate Events message. If the Control header is readable, ERROR refers to its messageId; otherwise, an ATT rejection is sufficient. For a corrupted Events message, the phone stops the batch and retries FETCH later.

## 5. Messages and exact bodies

Notation: `u8/u16/u32/u64/i64` are integers of the specified bit width; `uuid` is 16 bytes; `sha256` is 32 bytes. No unspecified bytes are allowed. A response's request ID is the original command's messageId, not the response's messageId. Unknown types/tags/flag codes and incorrect exact lengths in v1 are INVALID_MESSAGE. GAP_NOTICE uses the same reasons 1/2 as canonical GAP.

| type | Direction, name | Body in order | Body / with CRC, bytes |
| --- | --- | --- | --- |
| 0x01 | C→D GET_STATUS | empty | 0 / 4 |
| 0x02 | C→D TIME_SET | bootId:uuid, utcMs:i64, uncertaintyMs:u32 | 28 / 32 |
| 0x03 | C→D FETCH | afterSequence:u64, limit:u16 (1..100) | 10 / 14 |
| 0x04 | C→D ACK_BATCH | batchId:uuid, throughSequence:u64, count:u16, digest:sha256 | 58 / 62 |
| 0x05 | C→D CANCEL_BATCH | batchId:uuid | 16 / 20 |
| 0x80 | D→C STATUS | requestId:u16, bootId:uuid, oldest:u64, latest:u64, overwrittenThrough:u64, timeValid:u8, firstUndated:u64, storageState:u8 | 52 / 56 |
| 0x81 | D→C TIME_ACCEPTED | requestId:u16, bootId:uuid, utcMs:i64, uptimeMs:u64, uncertaintyMs:u32 | 38 / 42 |
| 0x82 | D→C BATCH_BEGIN | requestId:u16, batchId:uuid, afterSequence:u64, throughSequence:u64, count:u16 | 36 / 40 |
| 0x83 | D→C BATCH_ENTRY | batchId:uuid, canonicalEntry:bytes | 34..93 / 38..97 |
| 0x84 | D→C BATCH_END | batchId:uuid, digest:sha256 | 48 / 52 |
| 0x85 | D→C TIME_PENDING | requestId:u16, bootId:uuid, firstUndated:u64, latest:u64 | 34 / 38 |
| 0x86 | D→C LIVE_READY | canonical READY entry | 77 / 81 |
| 0x87 | D→C ACK_ACCEPTED | requestId:u16, batchId:uuid | 18 / 22 |
| 0x88 | D→C GAP_NOTICE | fromSequence:u64, toSequence:u64, reason:u8 | 17 / 21 |
| 0x89 | D→C CANCELLED | requestId:u16, batchId:uuid | 18 / 22 |
| 0x8A | D→C LIVE_SAMPLE (v1.1) | bootId:uuid, sampleCounter:u64, uptimeMs:u64, ppm:u32 | 36 / 40 |
| 0xFF | D→C ERROR | requestId:u16, code:u8 | 3 / 7 |

Unsolicited STATUS uses requestId=65535; this Control number is reserved. Other requestId values are 0..65534. timeValid is 0/1; storageState is 0 OK or 1 ERROR. oldest/latest are the bounds of available records, or 0/0 for an empty journal. `overwrittenThrough` is the last evicted sequence, or 0 if no eviction has occurred. firstUndated=0 if none exists.

If afterSequence is greater than latest, return INVALID_CURSOR: the local cursor must not be silently reset. The device reports the current STATUS in response to a separate request.

TIME_SET with a different bootId is rejected; utcMs in all three formats is validated against the shared range in section 4, without an additional positivity requirement. uncertaintyMs is an estimate of uncertainty on the device, not a zero-error accuracy guarantee. CLOCK_INVALID indicates unacceptable time. TIME_ACCEPTED means that the anchor has been stored; conversion of a large UNDATED range may still be in progress, in which case FETCH returns BUSY. SCD41 errors are reported asynchronously as SENSOR_ERROR with requestId=65535. The binary protocol contains no error strings/JSON.

### 5.1 LIVE_SAMPLE: v1.1 preview

Exact body offsets: bootId — 0..15, sampleCounter — 16..23, uptimeMs — 24..31, ppm — 32..35. bootId is a UUID v4 with the RFC variant; numbers are little-endian, without padding. sampleCounter: 1..2^64−1; uptimeMs: 0..2^64−1; ppm: integer 1..100000 with additional SCD41 validation in firmware. In JavaScript, both u64 fields are handled as BigInt. The 36-byte body plus CRC32 is 40 bytes; three ATT fragments have lengths of 20, 20 and 18 bytes. CRC and the major=1 header follow section 4, with type=0x8A.

**sampleCounter is not the journal sequence.** It is a RAM counter of valid sensor samples within a bootId, starting at 1. A new measurement increments it; absence of a phone, disconnect/reconnect, a change of preview mode and recovery from a sensor error do not reset it. An invalid read does not create a sample. A new boot changes bootId and restarts the counter at 1. When u64 is exhausted, publication stops until a new boot; wraparound is prohibited. Retransmission of the same sample preserves bootId/sampleCounter/uptimeMs/ppm but uses a new transport messageId. Counter gaps are allowed and do not create a journal GAP.

The codec validates ranges; the transport checks ordering/duplicates and whether bootId matches the current STATUS. The transmitter must advertise the appropriate version and capability; the receiver must check them before using LIVE_SAMPLE.

LIVE_SAMPLE contains no measurementId, segmentId, sequence or utcMs, is not a canonicalEntry/READY and does not promise a durable commit. uptimeMs is the sample acquisition time since the start of bootId; the phone's reception time does not replace the sensor's UTC. Delivery is best-effort: the notification is not stored for FETCH, does not require ACK_BATCH, does not advance the cursor and is not imported as an ordinary measurement into history/backend. The LIVE_READY (0x86) format and its persistence/UTC obligations remain unchanged.

The current minimal firmware implements the following preview mode:

- After subscribing to Events, the central sends GET_STATUS. The transmitter opens the stream after NimBLE has successfully accepted all four STATUS fragments. Notify is not acknowledged by the application; the central still validates the assembled STATUS and requestId. bootId in LIVE_SAMPLE matches bootId in that STATUS.
- Only valid measurements acquired after completion of the handshake are transmitted, each at most once. Samples acquired before/during the handshake are skipped. There is one protected overwrite buffer for the latest sample between tasks; transmission delays may cause sampleCounter gaps.
- The Control response queue is limited to four pending messages. They take priority over the next LIVE_SAMPLE. A started message is transmitted in full, with immutable fields; fragments of different messages are not interleaved.
- A CRC/I²C error, CO₂=0 or 30 successful polls without a ready measurement invalidates the pending sample. The old value is not repeated. If an invalidated message has been partially transmitted, the connection is closed; ATT notifications already accepted cannot be recalled. Polling continues; recovery does not reset sampleCounter. SENSOR_ERROR is currently logged only as an error in monitor, without an ERROR packet.
- Disconnect discards pending messages. Unsubscription closes access to preview; resubscription requires a new GET_STATUS/STATUS. Unsubscribing in the middle of a message closes the connection. Only a new connection resets messageId, but not sampleCounter. Events uses 0..65535 without reuse and closes the connection after the final message with ID 65535. A send failure also closes the connection; there are no automatic message retries.

Successful transmission and correct CRCs confirm data integrity, not sensor accuracy; this is especially important after isopropanol has contacted the SCD41 membrane.

## 6. Canonical entries and digest

`canonicalEntry` has one of three exact formats:

| tag | Fields, including tag | Size |
| --- | --- | --- |
| 0x01 READY | tag:u8, sequence:u64, measurementId:uuid, bootId:uuid, segmentId:uuid, uptimeMs:u64, utcMs:i64, ppm:u32 | 77 |
| 0x02 UNDATABLE | tag:u8, sequence:u64, measurementId:uuid, bootId:uuid, segmentId:uuid, uptimeMs:u64, ppm:u32 | 69 |
| 0x03 GAP | tag:u8, fromSequence:u64, toSequence:u64, reason:u8 | 18 |

GAP reason: 1 OVERWRITTEN, 2 CORRUPT. A GAP with from>to is invalid. UNDATED has no canonicalEntry and is not included in an acknowledged batch.

The canonical digest header is `batchId:uuid || afterSequence:u64 || throughSequence:u64 || count:u16` (34 bytes). It is followed by exactly count canonicalEntry values in ascending sequence/range order. SHA-256 is computed over:

```text
ASCII("LL-BATCH-V1") || 0x00 || canonicalHeader || entry[0] || ... || entry[count-1]
```

The prefix is exactly 12 bytes: `4C 4C 2D 42 41 54 43 48 2D 56 31 00`. requestId, messageId, fragment indices and CRC are NOT included in the digest. The digest describes the contents of a specific batch, not the entire journal.

## 7. Journal download, cursor and atomic import

For existing records, the cursor may advance only through imported READY records or explicitly stored UNDATABLE records. It crosses a physically missing range only after a GAP has been atomically stored, without claiming that lost measurements were imported. An UNDATED record must not be crossed.

The phone stores a cursor per deviceId. It denotes the last sequence that has been finally processed, not the last LIVE measurement observed.

FETCH examines the journal strictly from afterSequence+1. The device captures a RAM snapshot of at most 100 canonicalEntry values (READY/UNDATABLE/GAP). Later flash eviction does not change this snapshot. batchId is a fresh UUID v4. count counts entries, not the number of sequence values inside a GAP; 1<=count<=limit<=100. There are at most 100 READY records. There is no empty BATCH_BEGIN.

throughSequence is the last sequence of the last entry (toSequence for GAP). The non-overlapping entries completely cover `(afterSequence, throughSequence]`: unreported holes are prohibited. The evicted portion before oldest is represented as GAP, not a silent cursor jump.

If terminal entries precede UNDATED, a batch containing only those entries is returned first. If the first next entry is UNDATED from the current boot, return TIME_PENDING, not an empty batch. The application stops the download loop and does not repeat the same FETCH on a timer. Resumption occurs after TIME_ACCEPTED and completion of processing, after a bootId change or through explicit user action. BUSY permits a retry through explicit action; there is no endless polling. When bootId changes, the old range becomes UNDATABLE and no longer blocks the cursor. READY records beyond an UNDATED barrier may arrive LIVE, but do not permit the main cursor to skip the barrier.

If afterSequence==latest, STATUS with the command's requestId means the download is complete.

The phone assembles the entire batch and validates batchId, count, digest, continuous coverage, bounds, ID uniqueness, field validity and the absence of extra bytes. In a single IndexedDB transaction, it:

1. Imports READY with the original IDs, `source=sensor`, `syncStatus=pending`. An existing identical record is unchanged, including its synced status. Different data under the same measurementId is a conflict: roll back the entire batch.
2. Stores UNDATABLE in a separate store and GAP as unavailability markers. GAP does not erase existing local measurements; the chart breaks where no local data covers the known loss.
3. Stores the throughSequence cursor and the `(batchId, count, digest)` receipt.

ACK_BATCH is sent only after commit. An IndexedDB error/capacity overflow permits neither ACK nor cursor advancement. A corrupted/incomplete batch is not acknowledged.

ACK is checked against the RAM snapshot retained on the ESP32: batchId, throughSequence, count and digest must match. An identical repeated ACK returns ACK_ACCEPTED. An unrelated/modified ACK produces ACK_MISMATCH; an expired/lost snapshot produces BATCH_EXPIRED. ACK completes the protocol exchange but **does not delete any record**, does not free the ring buffer and does not acknowledge HTTP synchronization.

Only one batch may be active at a time. A new FETCH before ACK/CANCEL/expiry returns BUSY. CANCEL does not change the journal, phone data or cursor. Disconnect discards the snapshot; after reconnect, the phone continues from its durable cursor. If commit succeeded but ACK was lost, the data is still safely stored. ACK may be retried before the snapshot expires; afterwards, use FETCH from the phone's cursor. If no commit occurred, a repeated FETCH may return a new batchId but the same measurementId values and data.

LIVE_READY is imported idempotently under the same immutability rules, but does not advance the main cursor and does not require ACK_BATCH. A mobile record under the same ID must not be duplicated during a subsequent journal download.

## 8. Ring buffer, history deletion and cursor loss

Each eviction advances overwrittenThrough; GAP_NOTICE may combine consecutive evictions. Notification is not guaranteed: STATUS and GAP inside FETCH determine the actual state. GAP_NOTICE does not advance the phone's cursor. Eviction of records already imported does not require a gap in local history.

Flash corruption is reported as CORRUPT only if the loss bounds are known; if the sequence cannot be recovered, return STORAGE_ERROR without inventing bounds.

Deleting local history atomically removes the associated cursors/receipts/markers. Active import is cancelled; its old response must not restore the cursor after deletion. On the next explicit history request, the device is read from afterSequence=0. Reinstallation/loss of IndexedDB works the same way. First return GAP for the portion already evicted, then ALL terminal records still available. Previous ACKs do not prevent this.

Previously deleted history may reappear: this is expected recovery that the UI must explain. Evicted ESP32 records cannot be recovered.

On reimport after deletion, READY records receive pending status. The backend already knows their measurementId values and accepts them as duplicates if their contents are identical. No participant may retroactively correct READY clocks/data.

## 9. Errors and timeouts

| Code | Name | Action |
| --- | --- | --- |
| 0x01 | UNSUPPORTED_VERSION | stop the exchange |
| 0x02 | INVALID_MESSAGE | reject the message/batch |
| 0x03 | BUSY | wait for completion or an explicit retry |
| 0x04 | INVALID_CURSOR | request STATUS and show the inconsistency |
| 0x05 | CLOCK_INVALID | reject the time/mismatched bootId |
| 0x06 | STORAGE_ERROR | show a journal error |
| 0x07 | SENSOR_ERROR | show a sensor error; start a new segment on recovery |
| 0x08 | ACK_MISMATCH | ACK was not accepted; delete nothing |
| 0x09 | BATCH_EXPIRED | retry the journal download/continue from the durable cursor |
| 0x0A | CRC_MISMATCH | discard the message |
| 0x0B | FRAGMENT_ERROR | discard the assembly |

TIME_PENDING is a normal response, not an error. STORAGE_FULL does not exist: a healthy ring buffer evicts old records. Errors unrelated to a command use requestId=65535.

- Message assembly: 5 seconds from the first fragment.
- First command response: 5 seconds after the last Control write response.
- Entire batch through BATCH_END: 30 seconds from BATCH_BEGIN, not extended by LIVE traffic.
- ESP32 waiting for ACK/CANCEL and caching repeated ACK: 30 seconds after BATCH_END.
- After timeout, the incomplete batch is discarded. There are no automatic endless retries; retries with jitter/backoff may be defined later. The native BLE transport must bound its queue rather than send an unlimited stream into WebView.
- During TIME_SET, LIVE may be paused until the journal update completes; confirmed records are always available through a subsequent FETCH.

## 10. Size verification

The largest body is BATCH_ENTRY READY: 16 + 77 = 93 bytes; with CRC, 97 bytes, ceil(97/14)=7 fragments. The largest ACK is 62 bytes with CRC, or 5 fragments. All other messages in the table are smaller. The logical limit of 128 yields at most 10 fragments: 9*14 + 2. Every ATT value is at most 6+14=20 bytes; Info=20. The 32-byte SHA-256 is transmitted in fragments, not in a single ATT value.

The RAM snapshot contains <=100*77=7700 canonical bytes plus its header and bookkeeping structures; the entire batch is not represented as one logical message.

## 11. Existing mobile application and HTTP batch API

The main UI uses Sensor readings; Simulator is not the default UI source. Co2Storage.append remains the simulator path. The separate READY import path already has a unique measurementId index, atomic import with a cursor, separate UNDATABLE/GAP storage and record equality checks. Firmware journal download is not yet available. Journal download must not masquerade as a stream of new Co2Source readings. A transport reconnect may change the source's UI session, but not the canonical segmentId.

### Browser LIVE_SAMPLE storage (client implementation, not a wire-contract change)

BrowserBleSession displays valid received LIVE_SAMPLE values and saves them through a separate local storage path, not simulator append. DeviceId comes from Info. The client assigns a random MeasurementId once per new (deviceId, bootId, sampleCounter), stores source="sensor" and syncStatus="pending", and automatically uploads through POST /api/measurements/batch. The browser uses bootId as its local segment value. Persistent identity keys prevent a replay, including after reconnect, from creating a new row. Both uint64 fields remain BigInt in the protocol and decimal strings in storage.

For this browser-created record, MeasuredAt is the browser's wall-clock reception time, captured before asynchronous storage. It is not sensor UTC, an uptime-derived timestamp or a canonical READY timestamp. This is a separate client record derived from a received preview; it does not turn LIVE_SAMPLE into canonicalEntry/READY or add persistence, UTC, ACK or FETCH obligations to the device. Section 5.1 remains the normative wire contract.

Automatic and manual HTTP sends are serialized. API failure leaves records pending; retries preserve their original IDs and data. Samples missed while disconnected are not recovered. This browser storage change does not affect Android.

READY: deviceId comes from Info, source="sensor", measurementId is the original ID, measuredAt is ISO 8601 UTC with Z derived from utcMs, ppm is unchanged, and segment is the canonical segmentId string (36 characters). bootId/sequence/uptime are local bookkeeping information, not new fields of the existing POST /api/measurements/batch.

Mobile continues to send up to 100 READY records, grouped by deviceId/source. The server allows up to 500 per batch, ppm 1..100000, segment up to 80 characters, UTC no more than 5 minutes in the future, and a body limit of 256 KiB. A validation error stops HTTP synchronization without modifying the original READY record. Repeated identical measurementId values produce duplicates; different data produces 409 with batch rollback. UNDATABLE and GAP are never substituted with fictitious API measurements.

## 12. Open prototype questions

- Flash partition capacity, measurement frequency, autonomous history duration, wear, the specific crash-consistent ring implementation and recovery tests.
- Security: pairing/bonding, encryption, permission to read history/change the clock/perform a factory reset; UUID/CRC/digest do not prove authenticity. Until this is resolved, the prototype is not considered protected against an unrelated central.
- Acceptable UTC uncertainty, detection of an incorrect phone clock and drift; READY must not be retroactively corrected to pass server validation.
- UI and retention period for UNDATABLE/loss markers; future compatibility with two-year local retention without invented calendar timestamps.
- Multiple phones, device ownership and recovery from the backend are not yet defined; v1 permits one central, and ACK does not imply a server copy.

Sources for platform constraints (the formats above are a custom protocol):

- [ESP-IDF: BLE connection / ATT MTU](https://docs.espressif.com/projects/esp-idf/en/release-v5.4/esp32c3/api-guides/ble/get-started/ble-connection.html)
- [ESP32-C3: system time, RTC loss on power-on reset](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/system_time.html)
- [ESP-IDF: storage APIs](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c3/api-reference/storage/index.html)
