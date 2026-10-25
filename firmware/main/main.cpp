#include "ble_server.hpp"
#include "esp_log.h"
#include "scd41.hpp"

extern "C" void app_main(void) {
  ESP_LOGI("lueftlotse", "Lueftlotse firmware started");
  lueftlotse::start_ble_server();
  lueftlotse::run_scd41_monitor();
}
