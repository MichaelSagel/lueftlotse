# Minimal NimBLE GATT server (ESP-IDF 6.1 / ESP32-C3)

Uses the UUID strings and binary codec from ble_protocol. The primary service
is advertised; the complete name Lueftlotse is in the scan response to fit
legacy advertising's 31-byte limit. No advertising while connected. Host
configuration permits one connection.

- Info: read-only, 20 bytes, v1.1, capabilities 0x0010 (LIVE_SAMPLE only).
- Control: write-with-response only, GET_STATUS only.
- Events: notify-only; subscribe before GET_STATUS.
- STATUS: matching requestId, current bootId, oldest/latest/overwrittenThrough/
  firstUndated all zero, timeValid=0, storageState=0 (no journal error).
- LIVE_SAMPLE: SCD41 CO2 preview, current bootId shared with STATUS, boot-local
  sampleCounter, acquisition uptimeMs and ppm. Three frames: 20/20/18 bytes.
- No clock synchronization, LIVE_READY, journal, FETCH or batch ACK.

deviceId is a UUID v4 stored once as the 16-byte NVS blob
lueftlotse/device_id, committed before advertising. Existing invalid/corrupt
identity or NVS initialization errors stop startup; NVS is never auto-erased.
bootId is newly generated each boot. An entropy source is enabled only during
early UUID generation and disabled before RF startup. Neither ID is a BLE MAC.

All session state, access callbacks and the 50-ms callout run in the NimBLE
host queue. The callout checks assembler expiry even without received data.
The scheduler has one active immutable message and at most four waiting Control
replies. It sends one frame per callout and finishes an active message before
selecting the next one; fragments of different messages never interleave.
Waiting Control replies have priority over preview. Queue overflow receives an
ATT resource error; rejected parsed commands still consume their Control ID.
A new request must use a fresh ID. ATT write success accepts the command only.
Unsubscribed, malformed, unsupported or replayed commands are rejected via ATT;
protocol ERROR notifications are outside this minimal codec subset.

The SCD41 task publishes only after all response CRCs and nonzero CO2 have passed.
It shares one overwrite slot with the host task; a short FreeRTOS portMUX critical
section protects EVERY publish, invalidation and snapshot, including uint64s.
I2C, encoding, logging and NimBLE calls happen outside that section. There is no
measurement FIFO, heap allocation or blocking wait between these tasks.
sampleCounter increments for each correct measurement even without a central;
it survives disconnect, resubscribe and NimBLE host reset. It is unrelated to
journal sequence and resets only at reboot. u64 exhaustion disables publication
until reboot, without wrap. uptimeMs is captured when the sample is published.

Preview opens only after subscription and successful local TX acceptance of all
four fragments of the first requested STATUS. Notify has no application ACK;
this gate does not prove that the phone has received or decoded STATUS. The
current sample counter at completion becomes a baseline: samples obtained before
or during the handshake are skipped. Only a newer sample can be sent, once.
When Control delays preview, newer readings overwrite the waiting sample;
an already active packet remains immutable. Counter gaps are therefore normal.

An SCD41 I2C/CRC error, zero ppm or 30 successful not-ready polls invalidates the
slot. An invalidation watermark also discards a copied unsent sample, even if a
new good measurement arrived before the host's next tick. If some fragments of
that invalidated sample have already been sent, the session closes. Accepted
ATT notifications cannot be recalled, but old values are never retried. A new
valid sample permits recovery; initialization failure still requires reboot.
Sensor errors remain in monitor; no SENSOR_ERROR packet is added here.

Disconnect drops active and queued messages. Idle unsubscribe clears the
handshake gate and Control queue; resubscribe requires a fresh GET_STATUS and
skips older samples. Unsubscribe during a partially sent message, notification
allocation/TX failure or ID exhaustion closes the session. Events IDs 0..65535
are used once; after completing ID 65535 the connection closes, with no wrap.
Resubscribe does not reset either direction's IDs; only a NEW connection resets
the Control assembler and outgoing Events ID allocator. Termination failure
schedules a host reset. No partial message resumes or automatically retries.
There is no unsolicited STATUS stream, persistence or mobile UI integration.

## Build

After activating the installed ESP-IDF 6.1 environment for the current shell,
from the repository root:

~~~powershell
idf.py -C firmware -D SDKCONFIG=build/sdkconfig build
~~~

This uses sdkconfig.defaults and keeps generated configuration in ignored
build/. The older ignored firmware/sdkconfig is not used by this command.
No extra dependencies or system configuration changes are needed.

API references checked against the installed v6.1 headers and examples:
- examples/bluetooth/nimble/blehr/main/{main.c,gatt_svr.c}
- examples/bluetooth/nimble/blecsc/main/main.c
- host/ble_gatt.h: ble_gatts_notify_custom consumes its mbuf even on failure
- host/src/ble_gattc.c: ble_gatts_notify_custom emits NOTIFY_TX synchronously;
  status 0 is local acceptance, not an application delivery acknowledgement
- host/ble_uuid.h: ble_uuid_from_str handles canonical UUID strings
- nimble/nimble_npl_os.h: host-queue callout initialization/reset/stop
- bootloader_random.h: disable entropy source before RF initialization

Official example source:
https://github.com/espressif/esp-idf/tree/v6.1/examples/bluetooth/nimble/blehr

Build checks compile/link compatibility, not radio behavior. Run
`firmware/tests/run-vectors.ps1` as described in ../ble_protocol/README.md.
QEMU compiles the production codec and live_preview scheduler. Tests cover
mailbox overwrite/invalidation/u64 exhaustion, pre-handshake gating, reconnect,
resubscribe, same bootId, Control priority/queue limits, immutable fragmented
messages, TX failures, invalidation followed by recovery between host ticks,
and all 65536 Events IDs without wrap, alongside the shared binary vectors.
QEMU does not emulate NimBLE, FreeRTOS concurrency or SCD41 hardware. The manual
checklist in ../../README.md covers the remaining radio/sensor checks, including
real MTU, errors, disconnect/resubscribe and identity across power cycles.

Valid transport/CRC does not establish sensor accuracy after isopropanol reached
the membrane. The SCD41 monitor warning remains in place.

Pairing/bonding/access control are not implemented; security remains an open
prototype question in docs/ble-protocol-v1.md.
