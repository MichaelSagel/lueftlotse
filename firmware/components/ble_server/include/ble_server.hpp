#pragma once
namespace lueftlotse {
// Starts the single NimBLE host. Fatal initialization errors stop startup.
// Invoke once from app_main before any other RF/ADC subsystem is initialized.
void start_ble_server();
} // namespace lueftlotse