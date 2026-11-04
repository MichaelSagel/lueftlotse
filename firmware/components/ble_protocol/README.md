# BLE v1.0/v1.1 codec subset

Implements Info (20 bytes), GET_STATUS (empty body), STATUS (52 bytes) and
LIVE_SAMPLE (36-byte body, 40 bytes with CRC, three ATT frames: 20/20/18),
CRC-32/ISO-HDLC and strict 20-byte ATT framing. No Bluetooth, clocks, NVS,
sensor, journal or command handler is implemented. The caller supplies device
identity/status; this component does not invent or persist them.

Fixed memory, no heap, exceptions or ID allocator. One Assembler per incoming
direction/connection; message IDs are tracked with an 8192-byte bitmap.
Invalid/incomplete messages never produce output. Call expire(monotonic_ms)
periodically, including when no bytes arrive; timeout is 5000 ms from the first
fragment. Only reset_connection on a NEW connection. Senders must allocate
fresh IDs on every attempt, without wrap; Control reserves 65535.
Only the three implemented message types are accepted, with exact lengths/counts.
Info has no CRC or framing, as specified.

Info defaults to minor=0/capabilities=0 for v1.0 callers. The NimBLE server
explicitly sets minor=1/capabilities=0x0010 for its SCD41 preview.
Minor 0 accepts subsets of 0x000F; minor 1 accepts subsets of 0x001F.
Unknown minors/major/capability bits are rejected. `supports_live_sample(info)`
requires valid Info v1.1 with bit 0x0010; bit 0 (LIVE_READY) does not grant preview.
The wire codec has no negotiated session state: a receiver must use this helper
before using LIVE_SAMPLE. A publisher must advertise the matching Info version
and capability, as the NimBLE server does.
Frame major remains 1. `Assembler(Type::live_sample)` is a pure codec test path,
not a second receiver to be attached alongside an existing session assembler.

`LiveSample.sample_counter` is a positive boot-local uint64, not journal sequence.
It does not imply persistence, UTC, ACK, FETCH, imports or a durable cursor.
The counter and uptime preserve the full uint64 range. No LIVE_READY implementation
or clock/journal changes are introduced.

## Tests without ESP32

Requires existing RISC-V GCC and QEMU with the RISC-V virt machine.
From the repository root, using tool paths from the local EIM installation:

```powershell
./firmware/tests/run-vectors.ps1 -ToolchainBin <riscv32-esp-elf/bin> -Qemu <qemu-system-riscv32.exe>
```

This builds the SAME component source for rv32im and runs a freestanding test
ELF under QEMU virt (not ESP32 emulation). Output and ELF stay in ignored build/.
No downloads. The test harness UART/exit addresses belong ONLY to QEMU virt.
A 15-second process timeout detects hangs. Info and GET_STATUS vectors match
frontend codec.spec.ts/fragments.spec.ts; STATUS frame vectors are also pinned
in frontend fragments.spec.ts. Tests cover CRC corruption, incomplete sequences,
duplicates, deadlines, flags/bounds, UUID/version checks, uint64 max and ID
exhaustion. Firmware compilation separately checks ESP32-C3 toolchain compatibility.

LIVE_SAMPLE/Info fixtures are shared with TypeScript in
`docs/test-vectors/ble-live-sample-v1.1.json`. The runner turns these literal
values into a header in ignored build/; it does not generate expected wire bytes
or CRCs. Tests cover v1.0/v1.1 capability masks, UUID version/variant, exact sizes,
uint64 boundaries, bad fields with valid CRC, corruption, fragment order and expiry.

Not verified here: real GATT reads/writes/notifications, radio MTU negotiation,
timing on hardware, disconnect behavior, persistent identity or journal.
The codec remains transport-independent; the application now uses the separate
ble_server component for the NimBLE Info/GET_STATUS/STATUS handshake and SCD41
LIVE_SAMPLE preview. The same QEMU runner also tests its production scheduler;
see ../ble_server/README.md for the transport rules and coverage.
