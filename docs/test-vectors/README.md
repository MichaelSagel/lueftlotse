# Shared BLE v1.1 vectors

`ble-live-sample-v1.1.json` is the single input for the C++ and TypeScript tests.
The literals were calculated independently using Python `struct.pack('<QQI', ...)`
and `zlib.crc32(bytes([1, 0x8a]) + messageId_le + body)`.
UUID bytes use canonical hex order; CRC bytes use little-endian order.

Info cases include both minors with zero/all known capabilities and preview-only
v1.1. LIVE_SAMPLE cases cover the minimum sample counter and uptime, values above
JavaScript's safe integer range, UINT64_MAX, ppm boundaries and Events ID 65535.
The u64 values are decimal strings in JSON to prevent precision loss in parsers.
Each case pins body, body-plus-CRC and all three complete ATT values.

`firmware/tests/run-vectors.ps1` translates literals to C++ initializers under
ignored build/; TypeScript imports the JSON directly. Neither test runner computes
its expected wire bytes or CRC from the implementation being tested.
