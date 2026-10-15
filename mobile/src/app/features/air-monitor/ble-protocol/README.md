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

The codec does not implement batch transfer state, ACK processing or durable import.
Those future layers must enforce the spec's 30-second batch deadline, verify the
received digest against `batchDigest()`, and commit the complete batch atomically.
Receiving a valid `BATCH_ENTRY` alone does not confirm a complete batch.

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
