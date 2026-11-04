# First run: ESP32-C3 Super Mini

You need ESP-IDF **6.1** installed through EIM, a USB-C data cable and the Lüftlotse Android application. These instructions are for Windows; run the commands from the **root of the lueftlotse repository**, not from mobile or firmware.

## 1. Environment and build

In EIM, open **Manage Installations → Open Dashboard**, then select **Open IDF Terminal** for the installed **v6.1** version. Alternatively, use the PowerShell shortcut created by EIM for that version. It activates a separate Python environment and the ESP-IDF tools for that terminal; there is no need to change the system PATH.

In the activated terminal, go to the repository root and run:

```powershell
idf.py --version
idf.py -C firmware -D SDKCONFIG=build/sdkconfig build
```

The version must be v6.1. The esp32c3 target and NimBLE are configured in sdkconfig.defaults. The generated configuration is stored in firmware/build/sdkconfig; this command does not use the older firmware/sdkconfig. The application image is firmware/build/lueftlotse_firmware.bin. Build output and local configuration files are excluded from Git. A normal build does not verify radio operation.

## 2. COM port, flashing and monitor

Connect the board over USB. In **Device Manager → Ports (COM & LPT)**, find the port that disappears when you unplug the board and reappears when you reconnect it. With native USB, it may be called USB Serial Device. Do not select the phone's port. **COM7 below is an example**: replace it with your own port and close other serial terminals.

```powershell
idf.py -C firmware -D SDKCONFIG=build/sdkconfig -p COM7 flash
idf.py -C firmware -D SDKCONFIG=build/sdkconfig -p COM7 monitor
```

Expect the line `Lueftlotse firmware started`. If you missed the startup log, briefly press RESET. Exit monitor with **Ctrl+]**; release the COM port before flashing again. The current configuration also outputs logs through the secondary USB Serial/JTAG console; the primary UART uses 115200 baud.

If automatic entry into flashing mode fails, including on the first connection through native USB:

1. Hold **BOOT**.
2. Briefly press and release **RESET/RST**, while continuing to hold BOOT.
3. Release BOOT, check the COM port again and repeat the flash command.
4. After a successful flash, if the application has not started, press RESET with BOOT released, then open monitor.

**Do not use erase-flash as a routine step.** A full erase removes NVS, including the persistent deviceId. Normal flashing preserves NVS when the partition table remains unchanged; the firmware does not automatically erase it on errors.

## 3. Android verification

Enable Bluetooth, open **Gerät verbinden**, start discovery and select **Lueftlotse → Verbinden**. The full name is included in the scan response; the service UUID is included in advertising. The application reads Info, validates v1.0/v1.1, subscribes to Events, sends GET_STATUS and waits for STATUS with the matching requestId.

Expect **STATUS bestätigt** and deviceId. Info is v1.1, capabilities = 0x0010; STATUS reports an empty journal, timeValid=0 and storageState=0. Firmware transmits the current CO₂ through LIVE_SAMPLE after the handshake. The main UI uses **Sensor** readings; Simulator is no longer the primary UI. The browser client displays received LIVE_SAMPLE values and also saves and uploads them as described below. This browser storage change does not affect Android. SCD41 verification is available through monitor and a BLE GATT inspector (see below). The journal, LIVE_READY, FETCH and **TIME_SET are not yet implemented**; measurement download cannot be tested yet.

### Browser client behavior

In Chrome with Web Bluetooth support, connect through **Sensor ausw?hlen** and wait for a new valid LIVE_SAMPLE. The browser displays the value, saves it locally in IndexedDB with source=sensor and pending status, then automatically sends it through the C# POST /api/measurements/batch API to PostgreSQL. DeviceId comes from Info; the browser assigns MeasurementId once and deduplicates by deviceId/bootId/sampleCounter, including after reconnect. API failures leave records pending; retries preserve the original IDs and data.

MeasuredAt is the browser's wall-clock time when the valid notification is received, not sensor UTC or uptime. This is separate client behavior: the LIVE_SAMPLE wire format and its best-effort, non-journal contract are unchanged. Samples missed while disconnected are not recovered. Android persistence is not changed by this browser implementation.

### Checking SCD41 through monitor

Connections: **SDA → GPIO0**, **SCL → GPIO1**, and common GND. The I²C bus operates at **100 kHz**; the sensor's 7-bit address is **0x62**. External SDA/SCL pull-ups to **3.3 V** are required (they may already be fitted on the module); internal pull-ups are enabled as supplementary pull-ups. The sensor's power supply must support its peak current; do not apply 5 V pull-ups to ESP32 GPIOs.

After starting BLE, the firmware waits for the sensor to become ready, stops any previous periodic mode (in case only the ESP32 was reset), reads the 48-bit serial number and starts periodic measurements at 5-second intervals. Monitor displays lines with the `scd41` tag: `Serial number: ...`, followed by `CO2=... ppm, temperature=... C, humidity=... %RH [accuracy unverified]`. Readiness is polled once per second; CRC-8 is checked for each word of the serial number, readiness status and measurements. Responses with CRC/I²C errors and CO₂=0 are discarded with a log message. If initialization fails, sensor checking stops until a restart, while BLE continues to operate; if reading a subsequent measurement fails, polling continues.

**Isopropanol previously contacted this sensor's membrane. Receiving data with a valid CRC confirms communication, not measurement accuracy.** The firmware prints this warning at startup. The check does not perform forced calibration, a factory reset or an EEPROM settings write; the sensor's automatic self-calibration setting remains unchanged. Only CO₂ is transmitted over BLE as a LIVE_SAMPLE preview. Temperature and humidity remain in monitor. Measurements are not written to the journal.

Commands, delays, conversions and CRC are implemented according to the [Sensirion SCD4x datasheet](https://sensirion.com/media/documents/48C4B7FB/67FE0194/CD_DS_SCD4x_Datasheet_D1.pdf).

### Checking LIVE_SAMPLE over BLE

Disconnect the Android application from the board and connect one BLE GATT inspector. UUIDs and packet formats are listed in the [specification](../docs/ble-protocol-v1.md).

1. Read Info: exactly 20 bytes, the first two bytes `01 01`, and the last two `10 00`. Subscribe to Events. No measurements should arrive before GET_STATUS.
2. Send GET_STATUS `010134120001f150a9d0` using write with response. Four STATUS fragments (type=0x80) with requestId=0x1234 must arrive first. Remove the 6-byte headers, assemble body+CRC and validate CRC32 according to the specification.
3. Wait for a new measurement after STATUS (usually about 5 seconds). LIVE_SAMPLE has type=0x8A and three fragments of 20/20/18 bytes sharing one Events messageId. After assembly and CRC validation, the body is 36 bytes: bootId at bytes 0..15, sampleCounter:u64 at 16..23, uptimeMs:u64 at 24..31, and ppm:u32 at 32..35. bootId must match STATUS, and ppm must match the new reading in monitor.
4. Check at least three measurements: sampleCounter and uptimeMs increase, and each measurement is transmitted once. Receiving valid data does not confirm sensor accuracy after exposure to isopropanol.
5. Disconnect, wait for several measurements in monitor, reconnect and repeat the handshake. bootId is unchanged; sampleCounter continues increasing, and old samples are not replayed. Repeat unsubscribe/subscribe: preview remains closed until a new GET_STATUS; within the same connection, a new Control messageId and CRC are required. Unsubscribing in the middle of a message causes firmware to close the connection.
6. For repeated GET_STATUS requests, responses take priority between complete messages. STATUS and LIVE_SAMPLE fragments must not be interleaved. When diagnosing an I²C/CRC error, the old ppm value is not resent; after recovery, only a new valid sample arrives. An error during transmission closes the connection.

Firmware uses one thread-safe buffer for the latest sample and a queue of up to four pending Control responses. sampleCounter gaps are allowed: it counts valid reads in RAM and is not the journal sequence. After Events messageId=65535, the connection closes without wraparound. Successful local transmission of STATUS through NimBLE opens preview, but Notify does not provide an acknowledgement from the application.

Automated codec and scheduler checks are described in [ble_server/README.md](components/ble_server/README.md). The checks above require a board running this firmware; a build and QEMU do not replace verification of the radio and SCD41.

## 4. Identity after restart

Record deviceId from the Android UI. Restart the board using RESET or by disconnecting power, then discover and connect to it again: **deviceId must remain unchanged**, while **bootId in the new STATUS must change**.

bootId is not yet displayed in the Android UI. To check it separately, disconnect Lüftlotse from the board (only one central is allowed) and use a BLE GATT inspector:

- The Info, Control and Events UUIDs are listed in the [specification](../docs/ble-protocol-v1.md).
- Subscribe to Events and send the fixed GET_STATUS `010134120001f150a9d0` to Control using **write with response**.
- Save the four STATUS fragments in order. To assemble them, remove the 6-byte header from each fragment, concatenate the payloads, and validate/remove the final 4 CRC bytes according to the specification. In the 52-byte body, bootId occupies bytes **2..17** (zero-based offsets), after the two-byte requestId.
- Repeat after restarting and establishing a new connection. The same GET_STATUS is valid on a new connection; within one connection, every request requires a new messageId and a recomputed CRC. Compare bootId UUIDs in canonical order.

NVS persistence, BLE exchange, reconnection and connection-count limits require verification on a real board; a successful build and QEMU codec tests do not confirm them. Pairing and access control are not yet implemented.

## Official ESP-IDF 6.1 instructions

- [Windows: EIM activation, build, flash, monitor](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c3/get-started/windows-start-project.html)
- [COM port and manual BOOT/RESET](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c3/get-started/establish-serial-connection.html)
- [USB Serial/JTAG console](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32c3/api-guides/usb-serial-jtag-console.html)
