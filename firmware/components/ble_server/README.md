# Minimal NimBLE GATT server (ESP-IDF 6.1 / ESP32-C3)

Uses the UUID strings and binary codec from ble_protocol. The primary service
is advertised; the complete name Lueftlotse is in the scan response to fit
legacy advertising's 31-byte limit. No advertising while connected. Host
configuration permits one connection.

- Info: read-only, 20 bytes, capabilities 0x0000.
- Control: write-with-response only, GET_STATUS only.
- Events: notify-only; subscribe before GET_STATUS.
- STATUS: matching requestId, current bootId, oldest/latest/overwrittenThrough/
  firstUndated all zero, timeValid=0, storageState=0 (no journal error).
- No live readings, clock synchronization, journal, FETCH, batch ACK or sensor.

deviceId is a UUID v4 stored once as the 16-byte NVS blob
lueftlotse/device_id, committed before advertising. Existing invalid/corrupt
identity or NVS initialization errors stop startup; NVS is never auto-erased.
bootId is newly generated each boot. An entropy source is enabled only during
early UUID generation and disabled before RF startup. Neither ID is a BLE MAC.

All session state, access callbacks and the 50-ms callout run in the NimBLE
host queue. The callout checks assembler expiry even without received data.
One pending STATUS (four <=20-byte frames) is allowed, one frame per callout.
Additional commands while that response is pending receive an ATT resource
error; rejected parsed commands still consume their Control ID. A new request
must use a fresh ID. ATT write success is not proof of STATUS delivery.
Unsubscribed, malformed, unsupported or replayed commands are rejected via ATT;
protocol ERROR notifications are outside this minimal codec subset.

Disconnect drops pending notifications; a new connection resets Control
assembler and the independent outgoing Events counter. Unsubscribe during a
pending response, send allocation/failure, or ID exhaustion closes the session.
Termination failure schedules a host reset. A STATUS is not resumed after
resubscribe/reconnect. No unbounded TX queue or automatic command retries.
There is no unsolicited STATUS stream at this stage.

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
- host/ble_uuid.h: ble_uuid_from_str handles canonical UUID strings
- nimble/nimble_npl_os.h: host-queue callout initialization/reset/stop
- bootloader_random.h: disable entropy source before RF initialization

Official example source:
https://github.com/espressif/esp-idf/tree/v6.1/examples/bluetooth/nimble/blehr

Build checks compile/link compatibility, not radio behavior. Existing QEMU
codec tests cover bytes, CRC and assembly only. Hardware verification remains:
advertising/name visibility, Info/CCCD, GET_STATUS/fragment order, real MTU,
disconnect/resubscribe, one-central limit and NVS identity across power cycles.

Pairing/bonding/access control are not implemented; security remains an open
prototype question in docs/ble-protocol-v1.md.