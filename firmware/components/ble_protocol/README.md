# BLE v1 codec subset

Implements Info (20 bytes), GET_STATUS (empty body) and STATUS (52 bytes),
CRC-32/ISO-HDLC and strict 20-byte ATT framing. No Bluetooth, clocks, NVS,
sensor, journal or command handler is implemented. The caller supplies device
identity/status; this component does not invent or persist them.

Fixed memory, no heap, exceptions or ID allocator. One Assembler per incoming
direction/connection; message IDs are tracked with an 8192-byte bitmap.
Invalid/incomplete messages never produce output. Call expire(monotonic_ms)
periodically, including when no bytes arrive; timeout is 5000 ms from the first
fragment. Only reset_connection on a NEW connection. Senders must allocate
fresh IDs on every attempt, without wrap; Control reserves 65535.
Only the two implemented message types are accepted, with exact lengths/counts.
Info has no CRC or framing, as specified.

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
mobile codec.spec.ts/fragments.spec.ts; STATUS frame vectors are also pinned
in mobile fragments.spec.ts. Tests cover CRC corruption, incomplete sequences,
duplicates, deadlines, flags/bounds, UUID/version checks, uint64 max and ID
exhaustion. Firmware compilation separately checks ESP32-C3 toolchain compatibility.

Not verified here: real GATT reads/writes/notifications, radio MTU negotiation,
timing on hardware, disconnect behavior, persistent identity or journal.
The application still only logs its startup message.