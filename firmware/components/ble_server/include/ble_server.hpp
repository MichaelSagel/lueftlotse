#pragma once
#include <stdint.h>
namespace lueftlotse {
// Starts the single NimBLE host. Fatal initialization errors stop startup.
// Invoke once from app_main before any other RF/ADC subsystem is initialized.
void start_ble_server();
// Task-context only. Called once per NEW CRC-validated sample. These operations
// use one bounded critical section and never call NimBLE, I2C, logging or flash.
bool publish_co2_sample(uint32_t ppm);
void invalidate_co2_sample();
} // namespace lueftlotse
