#include "ble_server.hpp"
#include "esp_log.h"

extern "C" void app_main(void) {
  ESP_LOGI("lueftlotse", "Lueftlotse firmware started");
  lueftlotse::start_ble_server();
}